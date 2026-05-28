import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "@/lib/db";
import {
  updateGfQuoteDetails,
  getGfQuoteByShortId,
  appendAuditLog,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";
import { fetchProject, fetchPersonsByIds } from "@/lib/bmi-office-actions";
import { fetchReservationProducts } from "@/lib/hermes-client";
import { notifyContractUpdated } from "@/lib/group-function-notify";

/**
 * Group quote sync cron.
 *
 * Runs every 5 minutes. Checks all active quotes (contract_sent,
 * deposit_paid, balance_charged) against live BMI Office data.
 * If customer, planner, date, or products changed:
 *   - Pre-deposit: updates quote + re-sends notification
 *   - Post-deposit: archives signed PDF, sets resign_required
 */

const HERMES_CENTER_MAP: Record<string, string> = {
  "fort-myers": "10.48.0.14",
  fasttrax: "10.48.0.14",
  naples: "10.40.0.43",
};

const SYNC_STATUSES = ["contract_sent", "deposit_paid", "balance_charged", "balance_link_sent"];

export async function GET(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, error: "DB not configured" }, { status: 500 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const q = sql();

  const quotes = (await q`
    SELECT * FROM group_function_quotes
    WHERE status IN ('contract_sent', 'deposit_paid', 'balance_charged', 'balance_link_sent', 'resign_required')
      AND event_date > NOW() - INTERVAL '7 days'
    ORDER BY event_date ASC
    LIMIT 30
  `) as GroupFunctionQuote[];

  const results: Array<{ id: number; eventName: string; status: string; action: string; changes?: string[] }> = [];

  for (const quote of quotes) {
    try {
      const result = await syncQuote(quote, dryRun);
      results.push(result);
    } catch (err) {
      console.error(`[group-quote-sync] error syncing quote=${quote.id}:`, err);
      results.push({
        id: quote.id,
        eventName: quote.event_name || "",
        status: quote.status,
        action: "error",
        changes: [err instanceof Error ? err.message : String(err)],
      });
    }
  }

  const updated = results.filter((r) => r.action === "updated" || r.action === "resign_required").length;
  console.log(
    `[group-quote-sync] checked=${quotes.length} updated=${updated} ` +
      `unchanged=${results.filter((r) => r.action === "unchanged").length}`,
  );

  return NextResponse.json({ ok: true, checked: quotes.length, updated, results });
}

const normPhone = (p: string | null | undefined) => (p || "").replace(/\D/g, "");
const normDate = (d: string | null | undefined) => {
  if (!d) return "";
  try {
    // BMI stores local ET without timezone. DB may store UTC ISO or JS toString.
    // Compare YYYY-MM-DD in ET to avoid timezone/format false positives.
    const dt = new Date(d);
    const etStr = dt.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
    const etTime = dt.toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }); // HH:MM
    return `${etStr} ${etTime}`;
  } catch { return ""; }
};

async function syncQuote(
  quote: GroupFunctionQuote,
  dryRun: boolean,
): Promise<{ id: number; eventName: string; status: string; action: string; changes?: string[] }> {
  const project = await fetchProject(quote.center_code, quote.bmi_reservation_id);
  if (!project) {
    return { id: quote.id, eventName: quote.event_name || "", status: quote.status, action: "bmi_fetch_failed" };
  }

  const changes: string[] = [];
  const isSigned = quote.status !== "contract_sent";

  // Check customer
  const customerPersonId = project.personId as string;
  const persons = await fetchPersonsByIds(quote.center_code, [customerPersonId]);
  const customer = persons[0];

  if (customer) {
    if (customer.firstName !== quote.guest_first_name) changes.push(`customer_first: ${quote.guest_first_name} → ${customer.firstName}`);
    if (customer.lastName !== quote.guest_last_name) changes.push(`customer_last: ${quote.guest_last_name} → ${customer.lastName}`);
    if (customer.email && customer.email.toLowerCase() !== (quote.guest_email || "").toLowerCase()) changes.push(`customer_email: ${quote.guest_email} → ${customer.email}`);
    if (customer.phone && normPhone(customer.phone) !== normPhone(quote.guest_phone)) changes.push(`customer_phone: ${quote.guest_phone} → ${customer.phone}`);
  }

  // Check event date
  const bmiDate = project.date as string | undefined;
  if (bmiDate && normDate(bmiDate) !== normDate(quote.event_date)) {
    changes.push(`event_date: ${quote.event_date} → ${bmiDate}`);
  }

  // Check event name
  const bmiName = (project.name as string) || (project.displayName as string) || "";
  if (bmiName && bmiName !== quote.event_name) {
    changes.push(`event_name: ${quote.event_name} → ${bmiName}`);
  }

  // Check products via Hermes
  const hermesCenter = HERMES_CENTER_MAP[quote.center_code] || "10.48.0.14";
  let freshProducts: Array<{ name: string; overrideName: string | null; price: number; tax: number; qty: number; total: number; plu: string }> | null = null;
  try {
    freshProducts = await fetchReservationProducts(hermesCenter, quote.bmi_reservation_id);
    const existingProducts = (quote.line_items || []) as Array<{ name: string; qty: number; total: number }>;

    const productChanged =
      freshProducts.length !== existingProducts.length ||
      freshProducts.some((fp, i) => {
        const ep = existingProducts[i];
        return !ep || fp.name !== ep.name || fp.qty !== ep.qty || fp.total !== ep.total;
      });

    if (productChanged) {
      changes.push(`products: ${existingProducts.length} items → ${freshProducts.length} items`);
    }
  } catch (err) {
    console.warn(`[group-quote-sync] products fetch failed for quote=${quote.id}:`, err);
  }

  if (changes.length === 0) {
    return { id: quote.id, eventName: quote.event_name || "", status: quote.status, action: "unchanged" };
  }

  if (dryRun) {
    return { id: quote.id, eventName: quote.event_name || "", status: quote.status, action: isSigned ? "would_resign" : "would_update", changes };
  }

  // Apply contact/date/name changes
  const updates: Record<string, unknown> = {};
  if (customer) {
    if (customer.firstName !== quote.guest_first_name) updates.guest_first_name = customer.firstName;
    if (customer.lastName !== quote.guest_last_name) updates.guest_last_name = customer.lastName;
    if (customer.email && customer.email.toLowerCase() !== (quote.guest_email || "").toLowerCase()) updates.guest_email = customer.email;
    if (customer.phone && normPhone(customer.phone) !== normPhone(quote.guest_phone)) updates.guest_phone = customer.phone;
  }
  if (bmiDate && normDate(bmiDate) !== normDate(quote.event_date)) updates.event_date = bmiDate;
  if (bmiName && bmiName !== quote.event_name) updates.event_name = bmiName;

  // Update products if changed
  if (freshProducts && changes.some((c) => c.startsWith("products:"))) {
    const totalBill = freshProducts.reduce((s, p) => s + p.total, 0);
    const taxTotal = freshProducts.reduce((s, p) => s + (p.tax || 0) * p.total / (p.price || 1), 0);
    const totalCents = Math.round((totalBill + taxTotal) * 100);
    const taxCents = Math.round(taxTotal * 100);
    updates.line_items = freshProducts;
    updates.total_cents = totalCents;
    updates.tax_cents = taxCents;
    if (!isSigned) {
      const depositDueCents = Math.round(totalCents / 2);
      updates.deposit_due_cents = depositDueCents;
      updates.balance_cents = totalCents - depositDueCents;
    } else {
      updates.balance_cents = totalCents - quote.deposit_due_cents;
    }
  }

  if (Object.keys(updates).length > 0) {
    await updateGfQuoteDetails(quote.id, updates);
  }

  if (isSigned) {
    // Archive current signed PDF before requiring re-sign
    const q = sql();
    if (quote.signed_pdf_url) {
      const history = (quote.signed_pdf_history as unknown[]) || [];
      const archived = [
        ...history,
        {
          url: quote.signed_pdf_url,
          signedAt: quote.contract_signed_at,
          archivedAt: new Date().toISOString(),
          reason: changes.join("; "),
        },
      ];
      await q`UPDATE group_function_quotes SET
        signed_pdf_history = ${JSON.stringify(archived)}::jsonb,
        signed_pdf_url = NULL,
        contract_signed_at = NULL,
        signature_type = NULL,
        signature_data = NULL,
        document_seal = NULL,
        status = 'resign_required',
        updated_at = NOW()
      WHERE id = ${quote.id}`;
    } else {
      await q`UPDATE group_function_quotes SET
        status = 'resign_required',
        updated_at = NOW()
      WHERE id = ${quote.id}`;
    }

    await appendAuditLog({
      quoteId: quote.id,
      event: "resign_required_auto",
      metadata: { changes, trigger: "group-quote-sync" },
    });

    // Notify about the update
    const refreshed = await getGfQuoteByShortId(quote.contract_short_id!);
    if (refreshed) {
      notifyContractUpdated(refreshed).catch((err) =>
        console.error(`[group-quote-sync] notify error for quote=${quote.id}:`, err),
      );
    }

    console.log(`[group-quote-sync] RESIGN REQUIRED quote=${quote.id} changes=[${changes.join(", ")}]`);
    return { id: quote.id, eventName: quote.event_name || "", status: "resign_required", action: "resign_required", changes };
  }

  // Pre-deposit: just re-notify
  const refreshed = await getGfQuoteByShortId(quote.contract_short_id!);
  if (refreshed) {
    notifyContractUpdated(refreshed).catch((err) =>
      console.error(`[group-quote-sync] notify error for quote=${quote.id}:`, err),
    );
  }

  console.log(`[group-quote-sync] updated quote=${quote.id} changes=[${changes.join(", ")}]`);
  return { id: quote.id, eventName: quote.event_name || "", status: quote.status, action: "updated", changes };
}
