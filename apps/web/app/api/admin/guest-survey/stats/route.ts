import { NextRequest, NextResponse } from "next/server";
import { getGuestSurveyStats, type SurveyOrigin } from "@/lib/guest-survey-db";

/**
 * GET /api/admin/guest-survey/stats
 *
 * Aggregate dashboard counters: funnel (sent / opened / completed),
 * reward breakdown (pinz / gift_card / declined / redeemed), per-tag
 * completion, daily time series, per-center breakdown.
 *
 * Auth: middleware enforces ADMIN_CAMERA_TOKEN.
 *
 * Query params (all optional):
 *   - since        ISO  lower bound on sent_at
 *   - until        ISO  upper bound on sent_at
 *   - centerCode   string
 *   - origin       bowling|racing
 *   - tag          string  filter to surveys containing this tag
 *
 * Response shape: see GuestSurveyStats in guest-survey-db.ts
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const since = sp.get("since") || null;
  const until = sp.get("until") || null;
  const centerCode = sp.get("centerCode") || null;
  const origin = (sp.get("origin") as SurveyOrigin | null) || null;
  const tag = sp.get("tag") || null;

  try {
    const stats = await getGuestSurveyStats({ since, until, centerCode, origin, tag });
    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    console.error("[admin-debug] guest-survey/stats failed:", err);
    return NextResponse.json(
      { error: "stats failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
