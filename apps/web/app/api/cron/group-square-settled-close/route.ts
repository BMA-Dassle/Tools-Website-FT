import { NextRequest, NextResponse } from "next/server";
import {
  getQuotesStuckForBmiSettlement,
  markGfSquareSettledComplete,
  appendAuditLog,
  type GfQuoteStatus,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";
import { isDbConfigured } from "@/lib/db";
import { verifyCron } from "@/lib/cron-auth";
import { firePortalWebhookAsync } from "@/lib/portal-webhook";
import { findSettlementCheck, type SquareSettlementCheck } from "@/lib/square-settled-check";

/**
 * Square-settled auto-close cron.
 *
 * Some group events never finished our flow (stuck at `contract_sent`,
 * `deposit_paid`, or `balance_link_sent`) but were actually settled the old way:
 * at close-out the venue rings the event up on a Square POS check whose
 * ticket NAME starts with "BMI <event_number>" (e.g. "Bmi H1145 Angelina's 11th
 * Bday"). When that check is COMPLETED, the event is paid — we jump it to
 * `completed`.
 *
 * Detection (proven against prod): match `order.ticket_name` (the POS check name),
 * NOT an amount — close-out totals routinely drop vs our quoted total. We match a
 * COMPLETED order whose ticket_name starts with "BMI <event_number>" at the event's
 * location, created near the event date. The check AMOUNT is recorded for audit but
 * is NOT used to gate (deposits are collected separately, and totals get reduced at
 * close), so amount matching would miss real settlements.
 *
 * Discovery-first: `?dryRun=1` makes ZERO writes and reports, per event, the matched
 * check (or none). Future-dated events are reported `future` without a Square call —
 * no close-out check can exist yet.
 *
 * Unlike `group-dayof-close`, this sets `completed` DIRECTLY and does NOT gate on
 * `dayof_paid_at`: these events were paid at the POS outside our day-of gift-card
 * rail, so there is no gift-card payout to perform first (incident 2026-06-05 does
 * not apply). We never touch `square_dayof_order_id` or load gift cards.
 *
 * Query params (all optional):
 *   ?dryRun=1             — scan + report, no writes
 *   ?statuses=a,b,c       — override candidate statuses (csv)
 *   ?windowDays=180       — event_date within ± N days of now
 *   ?lookbackDays=7       — search checks created from event_date - N days …
 *   ?lookaheadDays=21     — … to event_date + N days
 *   ?limit=200            — max events scanned
 *
 * Kill switch: env GF_SQUARE_SETTLED_KILL (truthy) short-circuits the whole run.
 */

const truthy = (v: string | undefined) => /^(1|true|on|yes)$/i.test(v || "");
const DAY_MS = 86_400_000;

type Verdict = "settled" | "no_check" | "future" | "error";

interface Analysis {
  quote: GroupFunctionQuote;
  verdict: Verdict;
  check: SquareSettlementCheck | null;
  error?: string;
}

async function analyzeQuote(
  quote: GroupFunctionQuote,
  lookbackDays: number,
  lookaheadDays: number,
  nowMs: number,
): Promise<Analysis> {
  // A close-out check can't exist before the event happens.
  if (new Date(quote.event_date).getTime() > nowMs + DAY_MS) {
    return { quote, verdict: "future", check: null };
  }
  if (!quote.event_number) {
    return { quote, verdict: "no_check", check: null };
  }
  try {
    const check = await findSettlementCheck({
      locationId: quote.square_location_id,
      eventNumber: quote.event_number,
      eventMs: new Date(quote.event_date).getTime(),
      lookbackDays,
      lookaheadDays,
    });
    return { quote, verdict: check ? "settled" : "no_check", check };
  } catch (err) {
    return {
      quote,
      verdict: "error",
      check: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "23505" || /duplicate key|unique constraint/i.test(e?.message || "");
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, error: "DB not configured" }, { status: 500 });
  }
  if (truthy(process.env.GF_SQUARE_SETTLED_KILL)) {
    return NextResponse.json({ ok: true, skipped: "GF_SQUARE_SETTLED_KILL" });
  }

  const params = req.nextUrl.searchParams;
  const dryRun = params.get("dryRun") === "1";
  const statusesParam = (params.get("statuses") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as GfQuoteStatus[];
  const statuses = statusesParam.length > 0 ? statusesParam : undefined;
  const windowDays = Math.min(Math.max(Number(params.get("windowDays")) || 180, 1), 730);
  const lookbackDays = Math.min(Math.max(Number(params.get("lookbackDays")) || 7, 1), 120);
  const lookaheadDays = Math.min(Math.max(Number(params.get("lookaheadDays")) || 21, 1), 120);
  const limit = Math.min(Math.max(Number(params.get("limit")) || 200, 1), 500);

  let quotes: GroupFunctionQuote[];
  try {
    quotes = await getQuotesStuckForBmiSettlement({ statuses, windowDays, limit });
  } catch (err) {
    console.error("[group-square-settled-close] DB query failed:", err);
    return NextResponse.json({ ok: false, error: "DB query failed" }, { status: 500 });
  }

  const nowMs = Date.now();
  const analyzed = await Promise.all(
    quotes.map((q) => analyzeQuote(q, lookbackDays, lookaheadDays, nowMs)),
  );

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      window: { statuses: statuses ?? "default", windowDays, lookbackDays, lookaheadDays, limit },
      scanned: quotes.length,
      events: analyzed.map((a) => ({
        quoteId: a.quote.id,
        status: a.quote.status,
        eventNumber: a.quote.event_number,
        eventName: a.quote.event_name,
        eventDate: a.quote.event_date,
        center: a.quote.center_code,
        ourTotalCents: a.quote.total_cents,
        verdict: a.verdict,
        ...(a.error ? { error: a.error } : {}),
        check: a.check,
      })),
    });
  }

  // ── Live ────────────────────────────────────────────────────────────
  const summary = {
    scanned: quotes.length,
    completed: 0,
    skipped: { future: 0, no_check: 0, already_completed: 0, order_already_used: 0 } as Record<
      string,
      number
    >,
    errors: 0,
    completedQuoteIds: [] as number[],
  };

  for (const a of analyzed) {
    if (a.verdict === "error") {
      summary.errors++;
      console.error(`[group-square-settled-close] analyze error quote=${a.quote.id}: ${a.error}`);
      continue;
    }
    if (a.verdict !== "settled" || !a.check) {
      summary.skipped[a.verdict]++;
      continue;
    }

    try {
      const applied = await markGfSquareSettledComplete(a.quote.id, {
        squareSettledOrderId: a.check.orderId,
      });
      if (applied === 0) {
        summary.skipped.already_completed++;
        continue;
      }
      summary.completed++;
      summary.completedQuoteIds.push(a.quote.id);
      console.log(
        `[group-square-settled-close] completed quote=${a.quote.id} #${a.quote.event_number} ` +
          `check="${a.check.ticketName}" amount=${a.check.totalCents} order=${a.check.orderId}`,
      );

      // Best-effort side effects (each isolated — none blocks the close).
      try {
        await appendAuditLog({
          quoteId: a.quote.id,
          event: "square_settled_completed",
          metadata: {
            orderId: a.check.orderId,
            ticketName: a.check.ticketName,
            checkAmountCents: a.check.totalCents,
            ourTotalCents: a.quote.total_cents,
            locationId: a.quote.square_location_id,
            priorStatus: a.quote.status,
          },
        });
      } catch (err) {
        console.error(`[group-square-settled-close] audit log failed quote=${a.quote.id}:`, err);
      }

      try {
        const { appendProjectPrivateNote, noteTimestamp } =
          await import("@/lib/bmi-office-actions");
        await appendProjectPrivateNote({
          centerCode: a.quote.center_code,
          projectId: a.quote.bmi_reservation_id,
          note: `[${noteTimestamp()}] Event closed — settled at POS on check "${a.check.ticketName}" (Square order ${a.check.orderId})`,
        });
      } catch (err) {
        console.error(`[group-square-settled-close] BMI note failed quote=${a.quote.id}:`, err);
      }

      firePortalWebhookAsync("payment.balance_charged", {
        documentId: a.quote.contract_short_id,
        bmiCode: a.quote.bmi_reservation_id,
        venue: a.quote.center_code,
        status: "completed",
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        summary.skipped.order_already_used++;
        console.warn(
          `[group-square-settled-close] check ${a.check.orderId} already attributed — quote=${a.quote.id} skipped`,
        );
      } else {
        summary.errors++;
        console.error(`[group-square-settled-close] complete failed quote=${a.quote.id}:`, err);
      }
    }
  }

  console.log(
    `[group-square-settled-close] scanned=${summary.scanned} completed=${summary.completed} ` +
      `skipped=${JSON.stringify(summary.skipped)} errors=${summary.errors}`,
  );

  return NextResponse.json({ ok: true, dryRun: false, ...summary });
}
