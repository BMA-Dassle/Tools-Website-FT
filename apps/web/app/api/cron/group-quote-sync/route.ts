import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "@/lib/db";
import {
  updateGfQuoteDetails,
  getGfQuoteByShortId,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";
import { fetchProject, fetchPersonsByIds } from "@/lib/bmi-office-actions";
import { fetchReservationProducts } from "@/lib/hermes-client";
import { notifyContractUpdated } from "@/lib/group-function-notify";

/**
 * Group quote sync cron.
 *
 * Runs every 5 minutes. Checks all quotes in contract_sent status
 * (deposit not yet paid) against live BMI Office data. If customer,
 * planner, date, or products changed, updates the quote and re-sends
 * the contract notification.
 */

const HERMES_CENTER_MAP: Record<string, string> = {
  "fort-myers": "10.48.0.14",
  fasttrax: "10.48.0.14",
  naples: "10.40.0.43",
};

export async function GET(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, error: "DB not configured" }, { status: 500 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const q = sql();

  const quotes = (await q`
    SELECT * FROM group_function_quotes
    WHERE status = 'contract_sent'
      AND deposit_paid_at IS NULL
      AND event_date > NOW()
    ORDER BY event_date ASC
    LIMIT 20
  `) as GroupFunctionQuote[];

  const results: Array<{ id: number; eventName: string; action: string; changes?: string[] }> = [];

  for (const quote of quotes) {
    try {
      const result = await syncQuote(quote, dryRun);
      results.push(result);
    } catch (err) {
      console.error(`[group-quote-sync] error syncing quote=${quote.id}:`, err);
      results.push({
        id: quote.id,
        eventName: quote.event_name || "",
        action: "error",
        changes: [err instanceof Error ? err.message : String(err)],
      });
    }
  }

  const updated = results.filter((r) => r.action === "updated").length;
  console.log(
    `[group-quote-sync] checked=${quotes.length} updated=${updated} ` +
      `unchanged=${results.filter((r) => r.action === "unchanged").length}`,
  );

  return NextResponse.json({ ok: true, checked: quotes.length, updated, results });
}

async function syncQuote(
  quote: GroupFunctionQuote,
  dryRun: boolean,
): Promise<{ id: number; eventName: string; action: string; changes?: string[] }> {
  const project = await fetchProject(quote.center_code, quote.bmi_reservation_id);
  if (!project) {
    return { id: quote.id, eventName: quote.event_name || "", action: "bmi_fetch_failed" };
  }

  const changes: string[] = [];

  // Normalize phone for comparison (strip everything except digits)
  const normPhone = (p: string | null | undefined) => (p || "").replace(/\D/g, "");
  // Normalize date for comparison (compare just YYYY-MM-DDTHH:MM:SS, ignore timezone)
  const normDate = (d: string | null | undefined) => {
    if (!d) return "";
    const iso = new Date(d).toISOString();
    return iso.slice(0, 19);
  };

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

  // Check event date (normalize to avoid timezone/format false positives)
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
  try {
    const freshProducts = await fetchReservationProducts(hermesCenter, quote.bmi_reservation_id);
    const existingProducts = (quote.line_items || []) as Array<{ name: string; qty: number; total: number }>;

    const productChanged =
      freshProducts.length !== existingProducts.length ||
      freshProducts.some((fp, i) => {
        const ep = existingProducts[i];
        return !ep || fp.name !== ep.name || fp.qty !== ep.qty || fp.total !== ep.total;
      });

    if (productChanged) {
      changes.push(`products: ${existingProducts.length} items → ${freshProducts.length} items`);

      if (!dryRun) {
        const totalBill = freshProducts.reduce((s, p) => s + p.total, 0);
        const taxTotal = freshProducts.reduce((s, p) => s + (p.tax || 0) * p.total / (p.price || 1), 0);
        const totalCents = Math.round((totalBill + taxTotal) * 100);
        const taxCents = Math.round(taxTotal * 100);
        const depositDueCents = Math.round(totalCents / 2);

        await updateGfQuoteDetails(quote.id, {
          line_items: freshProducts,
          total_cents: totalCents,
          tax_cents: taxCents,
          deposit_due_cents: depositDueCents,
          balance_cents: totalCents - depositDueCents,
        });
      }
    }
  } catch (err) {
    console.warn(`[group-quote-sync] products fetch failed for quote=${quote.id}:`, err);
  }

  if (changes.length === 0) {
    return { id: quote.id, eventName: quote.event_name || "", action: "unchanged" };
  }

  if (dryRun) {
    return { id: quote.id, eventName: quote.event_name || "", action: "would_update", changes };
  }

  // Apply contact/date changes
  const updates: Record<string, unknown> = {};
  if (customer) {
    if (customer.firstName !== quote.guest_first_name) updates.guest_first_name = customer.firstName;
    if (customer.lastName !== quote.guest_last_name) updates.guest_last_name = customer.lastName;
    if (customer.email && customer.email.toLowerCase() !== (quote.guest_email || "").toLowerCase()) updates.guest_email = customer.email;
    if (customer.phone && normPhone(customer.phone) !== normPhone(quote.guest_phone)) updates.guest_phone = customer.phone;
  }
  if (bmiDate && normDate(bmiDate) !== normDate(quote.event_date)) updates.event_date = bmiDate;
  if (bmiName && bmiName !== quote.event_name) updates.event_name = bmiName;

  if (Object.keys(updates).length > 0) {
    await updateGfQuoteDetails(quote.id, updates);
  }

  // Re-notify
  const refreshed = await getGfQuoteByShortId(quote.contract_short_id!);
  if (refreshed) {
    notifyContractUpdated(refreshed).catch((err) =>
      console.error(`[group-quote-sync] notify error for quote=${quote.id}:`, err),
    );
  }

  console.log(`[group-quote-sync] updated quote=${quote.id} changes=[${changes.join(", ")}]`);
  return { id: quote.id, eventName: quote.event_name || "", action: "updated", changes };
}
