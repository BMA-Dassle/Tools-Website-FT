import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { sql, isDbConfigured } from "@/lib/db";
import {
  ensureGfSchema,
  getGfQuoteByShortId,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";
import { fetchProject } from "@/lib/bmi-office-actions";
import { createDayofOrder } from "@/lib/group-function-dayof";
import { verifyCron } from "@/lib/cron-auth";

/**
 * Group quote sync cron. Runs every 5 minutes.
 *
 * Its ONLY contract responsibility is detecting cancellations in BMI Office
 * (stateId = -4): cancel the quote, refund any Square payments, and notify.
 * It also performs two pieces of unrelated self-healing: sending waiver
 * reminders for deposited events, and backfilling missing day-of Square orders.
 *
 * It intentionally does NOT touch a sent/signed contract's content, never sends
 * a "Contract Updated" email, and never flips a contract to resign_required.
 * ALL contract sends / resends / updates / resigns flow exclusively through
 * group-quote-dispatch, which fires only when the event planner sets the BMI
 * project to "Send Contract". That is the single gate.
 *
 * History: auto-resign-on-detected-diff used to live here and emailed guests
 * behind the planner's back. A tz round-trip in its event_date write-back
 * (BMI returns a tz-less ET string; this cron wrote it into a timestamptz under
 * a GMT session, persisting it 4h off) made the diff non-converging, so a signed
 * event was spammed "Contract Updated" every 5 minutes. Removed 2026-06-08.
 * See tasks/lessons.md § "Send Contract is the only contract trigger".
 */

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, error: "DB not configured" }, { status: 500 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  await ensureGfSchema();
  const q = sql();

  const quotes = (await q`
    SELECT * FROM group_function_quotes
    WHERE status IN ('contract_sent', 'deposit_paid', 'balance_charged', 'balance_link_sent', 'resign_required')
      AND event_date > NOW() - INTERVAL '7 days'
      AND is_winback = FALSE
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

  const cancelled = results.filter(
    (r) => r.action === "cancelled" || r.action === "would_cancel",
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

  // Self-heal: create any missing day-of Square orders. createDayofOrder is best-effort at
  // deposit time and was never retried, so a transient Square failure (or line_items not yet
  // synced) left events with no day-of order — silently excluding them from the day-of payout
  // cron. Backfill them here so every deposit-paid event always gets one.
  let dayofBackfilled = 0;
  if (!dryRun) {
    try {
      const missingDayof = (await q`
        SELECT * FROM group_function_quotes
        WHERE deposit_paid_at IS NOT NULL
          AND (square_dayof_order_id IS NULL OR square_dayof_order_id = '')
          AND status NOT IN ('cancelled', 'denied', 'expired')
          AND event_date > NOW() - INTERVAL '1 day'
        ORDER BY event_date ASC
        LIMIT 10
      `) as GroupFunctionQuote[];

      for (const mq of missingDayof) {
        try {
          const dayof = await createDayofOrder(mq, randomBytes(8).toString("hex"));
          if (dayof) {
            await q`UPDATE group_function_quotes SET square_dayof_order_id = ${dayof.id}, updated_at = NOW()
              WHERE id = ${mq.id} AND (square_dayof_order_id IS NULL OR square_dayof_order_id = '')`;
            dayofBackfilled++;
            console.log(
              `[group-quote-sync] backfilled day-of order quote=${mq.id} order=${dayof.id}`,
            );
          } else {
            console.error(`[group-quote-sync] day-of order backfill returned no id quote=${mq.id}`);
          }
        } catch (err) {
          console.error(`[group-quote-sync] day-of order backfill failed quote=${mq.id}:`, err);
        }
      }
    } catch (err) {
      console.error("[group-quote-sync] day-of backfill query failed:", err);
    }
  }

  console.log(
    `[group-quote-sync] checked=${quotes.length} cancelled=${cancelled}` +
      (waiversSent > 0 ? ` waivers=${waiversSent}` : "") +
      (dayofBackfilled > 0 ? ` dayofBackfilled=${dayofBackfilled}` : ""),
  );

  return NextResponse.json({
    ok: true,
    checked: quotes.length,
    cancelled,
    waiversSent,
    dayofBackfilled,
    results,
  });
}

async function syncQuote(
  quote: GroupFunctionQuote,
  dryRun: boolean,
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

  // The only thing this cron acts on: a cancellation in BMI Office (stateId = -4).
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

  // Not cancelled. Sync deliberately does not mutate or re-send sent/signed
  // contracts — that is the planner's job via "Send Contract" (group-quote-dispatch).
  return {
    id: quote.id,
    eventName: quote.event_name || "",
    status: quote.status,
    action: "no_op",
  };
}
