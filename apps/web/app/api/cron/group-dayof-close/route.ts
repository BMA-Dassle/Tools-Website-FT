import { NextRequest, NextResponse } from "next/server";
import { updateGfStatus, type GroupFunctionQuote } from "@/lib/group-function-db";
import { sql, isDbConfigured } from "@/lib/db";
import { verifyCron } from "@/lib/cron-auth";

/**
 * Day-of auto-close cron for non-bowling group events.
 *
 * Runs every 15 minutes. Finds group function quotes where:
 *   - status = 'balance_charged' (fully paid)
 *   - event_date has passed (event time, not just date)
 *   - the day-of order has already been paid (dayof_paid_at set), OR
 *     there is no day-of order to pay (square_dayof_order_id IS NULL)
 *   - NOT a bowling-only event (bowling uses QAMF webhooks)
 *
 * Auto-completes the quote — the gift card has 100% of the total,
 * staff redeems it at the Square POS against the day-of order.
 *
 * The `dayof_paid_at` guard is critical: group-dayof-pay (every 5 min) and
 * this cron (every 15 min) both trigger on `status = 'balance_charged' AND
 * event_date <= NOW()`. Both fire at minute :00 — the first moment a just-arrived
 * event qualifies. Without the guard, this cron can flip status → 'completed'
 * before pay applies the gift card; pay's `WHERE status = 'balance_charged'`
 * then never matches again and the day-of order is stranded OPEN forever.
 * Gating on dayof_paid_at enforces pay-before-close. (Incident: 2026-06-05,
 * quotes #3286/#1354/#H2986 stranded.)
 *
 * Query params:
 *   ?dryRun=1  — scan + report, no status changes
 */

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, error: "DB not configured" }, { status: 500 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const q = sql();

  const quotes = (await q`
    SELECT * FROM group_function_quotes
    WHERE status = 'balance_charged'
      AND event_date <= NOW()
      AND (square_dayof_order_id IS NULL OR dayof_paid_at IS NOT NULL)
    ORDER BY event_date ASC
    LIMIT 50
  `) as GroupFunctionQuote[];

  // Filter out bowling-only events (check line_items for bowling products)
  const nonBowlingQuotes = quotes.filter((quote) => {
    const items = quote.line_items as Array<{ name: string }>;
    const hasBowling = items.some(
      (p) => p.name.toLowerCase().includes("bowling") || p.name.toLowerCase().includes("lane"),
    );
    const hasOtherActivities = items.some(
      (p) =>
        !p.name.toLowerCase().includes("bowling") &&
        !p.name.toLowerCase().includes("lane") &&
        !p.name.toLowerCase().includes("tax") &&
        !p.name.toLowerCase().includes("shoe"),
    );
    // Skip if ONLY bowling (no other activities)
    // If mixed (bowling + karts), still auto-close since the gift card covers all
    return !hasBowling || hasOtherActivities;
  });

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      totalPastEvents: quotes.length,
      eligibleForClose: nonBowlingQuotes.length,
      quotes: nonBowlingQuotes.map((q) => ({
        id: q.id,
        eventName: q.event_name,
        eventDate: q.event_date,
        giftCardGan: q.square_gift_card_gan,
      })),
    });
  }

  let closed = 0;
  let errors = 0;

  for (const quote of nonBowlingQuotes) {
    try {
      await updateGfStatus(quote.id, "completed");
      closed++;
      console.log(
        `[group-dayof-close] completed quote=${quote.id} ` +
          `event="${quote.event_name}" gc=${quote.square_gift_card_gan}`,
      );
    } catch (err) {
      errors++;
      console.error(`[group-dayof-close] failed to close quote=${quote.id}:`, err);
    }
  }

  console.log(
    `[group-dayof-close] closed=${closed} errors=${errors} ` +
      `total=${quotes.length} eligible=${nonBowlingQuotes.length}`,
  );

  return NextResponse.json({ ok: true, closed, errors });
}
