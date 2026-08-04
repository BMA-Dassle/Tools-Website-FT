import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { sweepAbandonedDealCheckouts } from "~/features/deals/service/abandon-recovery";

/**
 * GET /api/cron/deal-abandon-email
 *
 * One recovery email to guests who filled in the deal buy panel and did not
 * finish. Their name, email and phone are already in `deal_purchases` as a
 * `pending` row — persist-first means we captured them before touching Square —
 * and until this route existed nothing ever read them.
 *
 * DELIBERATELY NOT PART OF `deal-voucher-reconcile`. That cron recovers money
 * that has already been taken and vouchers that are already owed; this one sends
 * marketing. They must not share a blast radius: a bug here should never be able
 * to stall fulfilment, and the kill switch for one must not silence the other.
 *
 * Safe to re-run. `abandon_email_sent_at` is claimed with a conditional UPDATE
 * before each send, and the query excludes anyone who has since bought or has
 * already been mailed about the same deal. `?dryRun=1` lists who would be
 * emailed and sends nothing.
 *
 * Kill switch: `DEALS_ABANDON_EMAIL=false`.
 *
 * Scheduled hourly at :25 from 13:00 to 02:00 UTC — Vercel crons run in UTC, and
 * that window is roughly 9 AM to 10 PM Eastern. Deliberately not overnight: a
 * recovery email that arrives at 4 AM gets read as spam at breakfast, and the
 * one-hour minimum age means nothing is ever missed by waiting for morning.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const p = req.nextUrl.searchParams;
  const dryRun = p.get("dryRun") === "1";
  const limit = p.get("limit") ? Number(p.get("limit")) : undefined;
  const minAgeHours = p.get("minAgeHours") ? Number(p.get("minAgeHours")) : undefined;
  const maxAgeHours = p.get("maxAgeHours") ? Number(p.get("maxAgeHours")) : undefined;

  try {
    const summary = await sweepAbandonedDealCheckouts({
      dryRun,
      limit,
      minAgeHours,
      maxAgeHours,
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.error("[deal-abandon-email] failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sweep failed" },
      { status: 500 },
    );
  }
}
