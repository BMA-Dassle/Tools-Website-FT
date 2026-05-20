import { NextRequest, NextResponse } from "next/server";
import { getQuestionStats, type SurveyOrigin } from "@/lib/guest-survey-db";

/**
 * GET /api/admin/guest-survey/question-stats
 *
 * Per-question response distribution for completed surveys.
 *
 * For rating_1_5 / yes_no / multi questions, returns the answer
 * histogram + a numeric `averageRating` for rating_1_5. For 'text'
 * questions, returns a count + the 25 most-recent answers (for
 * spot-checking; use /list?format=csv for full text export).
 *
 * Auth: middleware enforces ADMIN_CAMERA_TOKEN.
 *
 * Query params (all optional):
 *   - since        ISO
 *   - until        ISO
 *   - centerCode   string
 *   - origin       bowling|racing
 *
 * Each result row:
 *   {
 *     questionId, tag, ordinal, question, kind,
 *     totalAnswered: number,
 *     distribution: { "<answer>": <count>, ... },
 *     averageRating: number | null,
 *     recentTextAnswers: string[]
 *   }
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const since = sp.get("since") || null;
  const until = sp.get("until") || null;
  const centerCode = sp.get("centerCode") || null;
  const origin = (sp.get("origin") as SurveyOrigin | null) || null;

  try {
    const stats = await getQuestionStats({ since, until, centerCode, origin });
    return NextResponse.json({
      ok: true,
      window: { since, until },
      filters: { centerCode, origin },
      count: stats.length,
      questions: stats,
    });
  } catch (err) {
    console.error("[admin-debug] guest-survey/question-stats failed:", err);
    return NextResponse.json(
      { error: "question-stats failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
