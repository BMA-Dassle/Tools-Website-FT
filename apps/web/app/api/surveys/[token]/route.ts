import { NextRequest, NextResponse } from "next/server";
import { getGuestSurveyByToken, markGuestSurveyOpened } from "@/lib/guest-survey-db";
import { recordTouch } from "~/features/marketing";

/**
 * GET /api/surveys/[token]
 *
 * Returns the public survey payload used to render the mobile survey page.
 * Excludes PII / reward audit fields — those live in the DB row only.
 *
 * 404 → unknown token
 * 410 → expired or already-completed (we treat both as "gone")
 * 200 → renderable payload + stamps opened_at if first time
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!token || token.length < 8 || token.length > 64) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }

  const survey = await getGuestSurveyByToken(token);
  if (!survey) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (survey.completedAt) {
    return NextResponse.json({ error: "already completed", completed: true }, { status: 410 });
  }

  if (new Date(survey.expiresAt) <= new Date()) {
    return NextResponse.json({ error: "expired", expired: true }, { status: 410 });
  }

  // Best-effort first-open stamp; failures don't block the response.
  if (!survey.openedAt) {
    markGuestSurveyOpened(token).catch((err) =>
      console.warn(`[surveys/${token}] markGuestSurveyOpened failed:`, err),
    );
    // Fire an 'opened' touch for funnel analytics (also non-blocking).
    recordTouch({
      customerId: survey.squareCustomerId,
      phoneE164: survey.phoneE164,
      campaign: "guest_survey",
      event: "opened",
      refId: token,
    }).catch((err) => console.warn(`[surveys/${token}] recordTouch(opened) failed:`, err));
  }

  return NextResponse.json({
    token: survey.token,
    origin: survey.origin,
    centerCode: survey.centerCode,
    visitDate: survey.visitDate,
    questions: survey.questions,
    expiresAt: survey.expiresAt,
  });
}
