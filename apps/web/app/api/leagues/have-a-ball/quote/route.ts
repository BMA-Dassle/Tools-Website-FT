import { NextResponse } from "next/server";
import { computeJoinPlan, habTodayYmd } from "~/features/have-a-ball/schedule";

/**
 * GET /api/leagues/have-a-ball/quote
 *
 * Returns the current join breakdown (server clock, ET) so the signup modal can
 * display real back-pay + go-forward numbers. The /join endpoint recomputes the
 * same plan at charge time — this is display only.
 */

export const dynamic = "force-dynamic"; // always reflect today's date

export async function GET() {
  const plan = computeJoinPlan(habTodayYmd());
  return NextResponse.json(plan, {
    headers: { "Cache-Control": "no-store" },
  });
}
