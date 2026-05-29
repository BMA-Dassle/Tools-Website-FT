import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "@/lib/db";
import {
  updateGfQuoteDetails,
  getGfQuoteByShortId,
  appendAuditLog,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";
import { fetchProject, fetchPersonsByIds } from "@/lib/bmi-office-actions";
import { fetchReservationProducts, fetchReservationDetail } from "@/lib/hermes-client";
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
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") {
    return NextResponse.json({ ok: true, skipped: "not production" });
  }

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

  const results: Array<{
    id: number;
    eventName: string;
    status: string;
    action: string;
    changes?: string[];
  }> = [];

  // Fetch planner data from Hermes for quotes missing it
  const plannerMap = new Map<string, PlannerInfo>();
  for (const quote of quotes) {
    if (!quote.planner_first && !quote.planner_last) {
      try {
        const hermesCenter =
          quote.center_code === "fasttrax" ? "10.48.0.14_FT" : HERMES_CENTER_MAP[quote.center_code];
        if (hermesCenter) {
          const hres = await fetchReservationDetail(hermesCenter, quote.bmi_reservation_id);
          if (hres?.planner?.first || hres?.planner?.last || hres?.planner?.email) {
            plannerMap.set(quote.bmi_reservation_id, hres.planner);
          }
        }
      } catch {
        /* non-fatal */
      }
    }
  }

  for (const quote of quotes) {
    try {
      const result = await syncQuote(quote, dryRun, plannerMap);
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

  const updated = results.filter(
    (r) => r.action === "updated" || r.action === "resign_required",
  ).length;

  // Send waiver reminders for quotes deposited 5+ minutes ago
  let waiversSent = 0;
  if (!dryRun) {
    try {
      const waiverDue = (await q`
        SELECT * FROM group_function_quotes
        WHERE deposit_paid_at IS NOT NULL
          AND waiver_reminder_sent_at IS NULL
          AND deposit_paid_at < NOW() - INTERVAL '5 minutes'
          AND status NOT IN ('cancelled', 'denied', 'expired')
          AND event_date > NOW()
        LIMIT 5
      `) as GroupFunctionQuote[];

      for (const wq of waiverDue) {
        try {
          const { notifyWaiverReminder } = await import("@/lib/group-function-notify");
          await notifyWaiverReminder(wq);
          await q`UPDATE group_function_quotes SET waiver_reminder_sent_at = NOW() WHERE id = ${wq.id}`;
          waiversSent++;
        } catch (err) {
          console.error(`[group-quote-sync] waiver reminder failed for quote=${wq.id}:`, err);
          // Mark as sent anyway to avoid retrying failures forever
          await q`UPDATE group_function_quotes SET waiver_reminder_sent_at = NOW() WHERE id = ${wq.id}`;
        }
      }
    } catch (err) {
      console.error("[group-quote-sync] waiver reminder query failed:", err);
    }
  }

  console.log(
    `[group-quote-sync] checked=${quotes.length} updated=${updated} ` +
      `unchanged=${results.filter((r) => r.action === "unchanged").length}` +
      (waiversSent > 0 ? ` waivers=${waiversSent}` : ""),
  );

  return NextResponse.json({ ok: true, checked: quotes.length, updated, waiversSent, results });
}

const normPhone = (p: string | null | undefined) => (p || "").replace(/\D/g, "");
const normDate = (d: string | null | undefined) => {
  if (!d) return "";
  try {
    // BMI stores local ET without timezone (e.g. "2026-05-28T07:00:00").
    // Append ET offset so JS doesn't treat it as UTC.
    const raw = String(d);
    const hasTimezone =
      raw.includes("Z") || raw.includes("+") || /\d-\d{2}:\d{2}$/.test(raw) || raw.includes("GMT");
    const dt = new Date(hasTimezone ? raw : `${raw}-04:00`);
    if (isNaN(dt.getTime())) return "";
    const etStr = dt.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const etTime = dt.toLocaleTimeString("en-GB", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${etStr} ${etTime}`;
  } catch {
    return "";
  }
};

type PlannerInfo = { first: string; last: string; email: string; phone: string };

async function syncQuote(
  quote: GroupFunctionQuote,
  dryRun: boolean,
  plannerMap?: Map<string, PlannerInfo>,
): Promise<{ id: number; eventName: string; status: string; action: string; changes?: string[] }> {
  const project = await fetchProject(quote.center_code, quote.bmi_reservation_id);
  if (!project) {
    return {
      id: quote.id,
      eventName: quote.event_name || "",
      status: quote.status,
      action: "bmi_fetch_failed",
    };
  }

  // Check for cancellation in BMI Office (stateId = -4)
  const bmiStateId = String(project.stateId || "");
  if (bmiStateId === "-4" && quote.status !== "cancelled") {
    if (dryRun) {
      return {
        id: quote.id,
        eventName: quote.event_name || "",
        status: quote.status,
        action: "would_cancel",
        changes: ["BMI state: Cancellation"],
      };
    }

    // Cancel the quote and refund Square payments
    const q = sql();
    await q`UPDATE group_function_quotes SET status = 'cancelled', updated_at = NOW() WHERE id = ${quote.id}`;

    const SQUARE_BASE = "https://connect.squareup.com/v2";
    const sqHeaders = () => ({
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN || ""}`,
      "Content-Type": "application/json",
      "Square-Version": "2024-12-18",
    });

    const refundedPayments: string[] = [];

    // Refund deposit payment
    if (quote.square_deposit_payment_id) {
      try {
        const refundRes = await fetch(`${SQUARE_BASE}/refunds`, {
          method: "POST",
          headers: sqHeaders(),
          body: JSON.stringify({
            idempotency_key: `gf-cancel-dep-${quote.id}`,
            payment_id: quote.square_deposit_payment_id,
            amount_money: { amount: quote.deposit_due_cents, currency: "USD" },
            reason: "Event cancelled by event planner",
          }),
        });
        const refundData = await refundRes.json();
        if (refundRes.ok && refundData.refund?.id) {
          refundedPayments.push(`deposit:${refundData.refund.id}`);
          console.log(
            `[group-quote-sync] refunded deposit $${(quote.deposit_due_cents / 100).toFixed(2)} for quote=${quote.id}`,
          );
        } else {
          console.error(
            `[group-quote-sync] deposit refund failed for quote=${quote.id}:`,
            JSON.stringify(refundData).slice(0, 300),
          );
        }
      } catch (err) {
        console.error(`[group-quote-sync] deposit refund error for quote=${quote.id}:`, err);
      }
    }

    // Refund balance payment
    if (quote.square_balance_payment_id) {
      try {
        const balanceAmount = quote.total_cents - quote.deposit_due_cents;
        const refundRes = await fetch(`${SQUARE_BASE}/refunds`, {
          method: "POST",
          headers: sqHeaders(),
          body: JSON.stringify({
            idempotency_key: `gf-cancel-bal-${quote.id}`,
            payment_id: quote.square_balance_payment_id,
            amount_money: { amount: balanceAmount, currency: "USD" },
            reason: "Event cancelled by event planner",
          }),
        });
        const refundData = await refundRes.json();
        if (refundRes.ok && refundData.refund?.id) {
          refundedPayments.push(`balance:${refundData.refund.id}`);
          console.log(
            `[group-quote-sync] refunded balance $${(balanceAmount / 100).toFixed(2)} for quote=${quote.id}`,
          );
        } else {
          console.error(
            `[group-quote-sync] balance refund failed for quote=${quote.id}:`,
            JSON.stringify(refundData).slice(0, 300),
          );
        }
      } catch (err) {
        console.error(`[group-quote-sync] balance refund error for quote=${quote.id}:`, err);
      }
    }

    await (
      await import("@/lib/group-function-db")
    ).appendAuditLog({
      quoteId: quote.id,
      event: "cancelled_from_bmi",
      metadata: { bmiStateId, refundedPayments },
    });

    // Send cancellation email
    const { notifyEventCancelled } = await import("@/lib/group-function-notify");
    const refreshed = await getGfQuoteByShortId(quote.contract_short_id!);
    if (refreshed) {
      notifyEventCancelled(refreshed, refundedPayments.length > 0).catch((err) =>
        console.error(`[group-quote-sync] cancel notify error for quote=${quote.id}:`, err),
      );
    }

    try {
      const { appendProjectPrivateNote, noteTimestamp } = await import("@/lib/bmi-office-actions");
      await appendProjectPrivateNote({
        centerCode: quote.center_code,
        projectId: quote.bmi_reservation_id,
        note: `[${noteTimestamp()}] Cancelled${refundedPayments.length > 0 ? ` | Refunds: ${refundedPayments.join(", ")}` : ""}`,
      });
    } catch {
      /* non-fatal */
    }

    console.log(`[group-quote-sync] CANCELLED quote=${quote.id} event="${quote.event_name}"`);
    return {
      id: quote.id,
      eventName: quote.event_name || "",
      status: "cancelled",
      action: "cancelled",
      changes: ["BMI state: Cancellation"],
    };
  }

  const changes: string[] = [];
  const isSigned = quote.status !== "contract_sent";

  // Check customer
  const customerPersonId = project.personId as string;
  const persons = await fetchPersonsByIds(quote.center_code, [customerPersonId]);
  const customer = persons[0];

  if (customer) {
    if (customer.firstName !== quote.guest_first_name)
      changes.push(`customer_first: ${quote.guest_first_name} → ${customer.firstName}`);
    if (customer.lastName !== quote.guest_last_name)
      changes.push(`customer_last: ${quote.guest_last_name} → ${customer.lastName}`);
    if (customer.email && customer.email.toLowerCase() !== (quote.guest_email || "").toLowerCase())
      changes.push(`customer_email: ${quote.guest_email} → ${customer.email}`);
    if (customer.phone && normPhone(customer.phone) !== normPhone(quote.guest_phone))
      changes.push(`customer_phone: ${quote.guest_phone} → ${customer.phone}`);
  }

  // Backfill planner from Hermes if missing
  if (!quote.planner_first && !quote.planner_last && plannerMap) {
    const planner = plannerMap.get(quote.bmi_reservation_id);
    if (planner) {
      changes.push(`planner: (empty) → ${planner.first} ${planner.last}`);
    }
  }

  // Check event date
  const bmiDate = project.date as string | undefined;
  if (bmiDate && normDate(bmiDate) !== normDate(quote.event_date)) {
    changes.push(`event_date: ${quote.event_date} → ${bmiDate}`);
  }

  // Check event name — AI format if changed
  let bmiName = (project.name as string) || (project.displayName as string) || "";
  if (bmiName && bmiName !== quote.event_name) {
    console.log(
      `[group-quote-sync] name change detected quote=${quote.id}: DB="${quote.event_name}" BMI="${bmiName}"`,
    );
    try {
      const { formatEventName } = await import("@/lib/event-name-format");
      console.log(`[group-quote-sync] calling formatEventName with: "${bmiName}"`);
      const formatted = await formatEventName(bmiName);
      console.log(
        `[group-quote-sync] formatEventName returned: "${formatted}" (changed=${formatted !== bmiName})`,
      );
      if (formatted !== bmiName) {
        const { updateProjectName } = await import("@/lib/bmi-office-actions");
        console.log(`[group-quote-sync] writing back formatted name to BMI...`);
        updateProjectName({
          centerCode: quote.center_code,
          projectId: quote.bmi_reservation_id,
          name: formatted,
        }).catch((err) => console.warn(`[group-quote-sync] BMI name writeback failed:`, err));
        bmiName = formatted;
      }
    } catch (err) {
      console.error("[group-quote-sync] AI name format FAILED:", err);
    }
    // Name changes tracked separately — don't trigger contract update email
  }

  // Check products via Hermes
  const hermesCenter = HERMES_CENTER_MAP[quote.center_code] || "10.48.0.14";
  let freshProducts: Array<{
    name: string;
    overrideName: string | null;
    price: number;
    tax: number;
    qty: number;
    total: number;
    plu: string;
  }> | null = null;
  try {
    freshProducts = await fetchReservationProducts(hermesCenter, quote.bmi_reservation_id);
    const existingProducts = (quote.line_items || []) as Array<{
      name: string;
      qty: number;
      total: number;
    }>;

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
    return {
      id: quote.id,
      eventName: quote.event_name || "",
      status: quote.status,
      action: "unchanged",
    };
  }

  if (dryRun) {
    return {
      id: quote.id,
      eventName: quote.event_name || "",
      status: quote.status,
      action: isSigned ? "would_resign" : "would_update",
      changes,
    };
  }

  // Apply changes
  const updates: Record<string, unknown> = {};
  // Name changes are silent (no email trigger) but still saved
  if (bmiName && bmiName !== quote.event_name) {
    updates.event_name = bmiName;
  }
  if (customer) {
    if (customer.firstName !== quote.guest_first_name)
      updates.guest_first_name = customer.firstName;
    if (customer.lastName !== quote.guest_last_name) updates.guest_last_name = customer.lastName;
    if (customer.email && customer.email.toLowerCase() !== (quote.guest_email || "").toLowerCase())
      updates.guest_email = customer.email;
    if (customer.phone && normPhone(customer.phone) !== normPhone(quote.guest_phone))
      updates.guest_phone = customer.phone;
  }
  if (!quote.planner_first && !quote.planner_last && plannerMap) {
    const planner = plannerMap.get(quote.bmi_reservation_id);
    if (planner) {
      updates.planner_first = planner.first;
      updates.planner_last = planner.last;
      updates.planner_email = planner.email;
      updates.planner_phone = planner.phone;
    }
  }
  if (bmiDate && normDate(bmiDate) !== normDate(quote.event_date)) {
    updates.event_date = bmiDate;
    // Reformat display date from raw BMI date (Hermes has AM/PM formatting bug)
    const hasTz = bmiDate.includes("Z") || bmiDate.includes("+") || /\d-\d{2}:\d{2}$/.test(bmiDate);
    const d = new Date(hasTz ? bmiDate : `${bmiDate}-04:00`);
    updates.event_date_display =
      d.toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
      }) +
      " " +
      d.toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
  }
  if (bmiName && bmiName !== quote.event_name) updates.event_name = bmiName;

  // Update products if changed
  if (freshProducts && changes.some((c) => c.startsWith("products:"))) {
    // Verify and correct service charge tier
    try {
      const { verifyAndCorrectServiceCharge } = await import("@/lib/service-charge");
      const scCheck = await verifyAndCorrectServiceCharge(
        quote.center_code,
        quote.bmi_reservation_id,
        freshProducts,
      );
      if (scCheck.corrected) {
        freshProducts = scCheck.products as typeof freshProducts;
        console.log(`[group-quote-sync] service charge corrected for quote=${quote.id}`);
      }
    } catch (err) {
      console.warn(`[group-quote-sync] service charge check failed for quote=${quote.id}:`, err);
    }

    const totalBill = freshProducts.reduce((s, p) => s + p.total, 0);
    const taxTotal = freshProducts.reduce(
      (s, p) => s + ((p.tax || 0) * p.total) / (p.price || 1),
      0,
    );
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

    // Log changes to BMI private notes
    try {
      const { appendProjectPrivateNote, noteTimestamp } = await import("@/lib/bmi-office-actions");
      const ts = noteTimestamp();
      const allChanges = [...changes];
      if (updates.event_name && updates.event_name !== quote.event_name) {
        allChanges.push(`event_name → ${updates.event_name}`);
      }
      if (allChanges.length > 0) {
        const summary = allChanges
          .map((c) => {
            if (c.startsWith("products:") || c.startsWith("event_name")) return c;
            return c.split(":")[0];
          })
          .join(", ");
        await appendProjectPrivateNote({
          centerCode: quote.center_code,
          projectId: quote.bmi_reservation_id,
          note: `[${ts}] Updated: ${summary}`,
        });
      }
    } catch {
      /* non-fatal */
    }
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

    console.log(
      `[group-quote-sync] RESIGN REQUIRED quote=${quote.id} changes=[${changes.join(", ")}]`,
    );
    return {
      id: quote.id,
      eventName: quote.event_name || "",
      status: "resign_required",
      action: "resign_required",
      changes,
    };
  }

  // Pre-deposit: just re-notify
  const refreshed = await getGfQuoteByShortId(quote.contract_short_id!);
  if (refreshed) {
    notifyContractUpdated(refreshed).catch((err) =>
      console.error(`[group-quote-sync] notify error for quote=${quote.id}:`, err),
    );
  }

  console.log(`[group-quote-sync] updated quote=${quote.id} changes=[${changes.join(", ")}]`);
  return {
    id: quote.id,
    eventName: quote.event_name || "",
    status: quote.status,
    action: "updated",
    changes,
  };
}
