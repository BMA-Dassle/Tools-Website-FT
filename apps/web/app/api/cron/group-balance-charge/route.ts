import { NextRequest, NextResponse } from "next/server";
import { getQuotesNeedingBalanceCharge, type GroupFunctionQuote } from "@/lib/group-function-db";
import { chargeBalanceForQuote } from "@/lib/group-balance-charge";
import { verifyCron } from "@/lib/cron-auth";

/**
 * 72-hour balance collection cron.
 *
 * Every 15 minutes, finds group function quotes where:
 *   - status = 'deposit_paid'
 *   - event is within 72 hours
 *   - event hasn't passed yet
 *
 * Path A: auto-charge saved card → LOAD gift card to 100%
 * Path B: create Square payment link → send to customer
 *
 * Both paths now live in `lib/group-balance-charge.ts` `chargeBalanceForQuote`,
 * so the CRM's "Charge balance now" and "Send balance link" run exactly this
 * code rather than a second copy of it. This route keeps the scan, the dry run
 * and the summary; the per-quote body moved unchanged.
 *
 * Query params:
 *   ?dryRun=1  — scan + report, no charges
 */

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  let quotes: GroupFunctionQuote[];
  try {
    quotes = await getQuotesNeedingBalanceCharge();
  } catch (err) {
    console.error("[group-balance-charge] DB query failed:", err);
    return NextResponse.json({ ok: false, error: "DB query failed" }, { status: 500 });
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      count: quotes.length,
      quotes: quotes.map((q) => ({
        id: q.id,
        eventName: q.event_name,
        eventDate: q.event_date,
        balanceCents: q.balance_cents,
        hasSavedCard: Boolean(q.saved_card_id),
      })),
    });
  }

  const results = await Promise.allSettled(quotes.map((q) => chargeBalanceForQuote(q)));

  const summary = {
    total: quotes.length,
    autoCharged: 0,
    linksSent: 0,
    skipped: 0,
    errors: 0,
  };

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      if (r.value === "auto_charged") summary.autoCharged++;
      else if (r.value === "link_sent") summary.linksSent++;
      else summary.skipped++;
    } else {
      summary.errors++;
      console.error(`[group-balance-charge] quote=${quotes[i].id} failed:`, r.reason);
    }
  }

  console.log(
    `[group-balance-charge] total=${summary.total} auto=${summary.autoCharged} ` +
      `links=${summary.linksSent} skipped=${summary.skipped} errors=${summary.errors}`,
  );

  return NextResponse.json({ ok: true, ...summary });
}
