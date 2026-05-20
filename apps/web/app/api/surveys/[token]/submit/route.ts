import { NextRequest, NextResponse } from "next/server";
import { getGuestSurveyByToken, saveGuestSurveyResponses } from "@/lib/guest-survey-db";
import { recordTouch } from "~/features/marketing";

/**
 * POST /api/surveys/[token]/submit
 *
 * Records the guest's answers and stamps completed_at.
 *
 * Body shape: { responses: Record<questionId, answerValue> }
 *   - answerValue is permissive (number / string / boolean / null) — the
 *     survey UI is responsible for shape per question kind.
 *
 * 400 → bad token or bad body shape
 * 404 → unknown token
 * 409 → already completed
 * 410 → expired
 * 200 → recorded + funnel touch
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!token || token.length < 8 || token.length > 64) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const responses = (body as { responses?: unknown })?.responses;
  if (!responses || typeof responses !== "object" || Array.isArray(responses)) {
    return NextResponse.json(
      { error: "responses must be an object keyed by questionId" },
      { status: 400 },
    );
  }

  const survey = await getGuestSurveyByToken(token);
  if (!survey) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (survey.completedAt) {
    return NextResponse.json({ error: "already completed" }, { status: 409 });
  }
  if (new Date(survey.expiresAt) <= new Date()) {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }

  await saveGuestSurveyResponses({
    token,
    responses: responses as Record<string, unknown>,
  });

  // 'converted' touch for funnel analytics — best-effort, non-blocking.
  recordTouch({
    customerId: survey.squareCustomerId,
    phoneE164: survey.phoneE164,
    campaign: "guest_survey",
    event: "converted",
    refId: token,
    meta: {
      origin: survey.origin,
      centerCode: survey.centerCode,
      questionCount: survey.questions.length,
      answerCount: Object.keys(responses as object).length,
    },
  }).catch((err) => console.warn(`[surveys/${token}/submit] recordTouch failed:`, err));

  return NextResponse.json({ ok: true, token });
}
