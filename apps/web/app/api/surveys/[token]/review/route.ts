import { NextRequest, NextResponse } from "next/server";
import { getGuestSurveyByToken } from "@/lib/guest-survey-db";
import { googleReviewUrl } from "~/lib/constants/review-links";
import { isPositiveSentiment, toAnswerMap } from "~/features/guest-survey/gating";
import { recordTouch } from "~/features/marketing";

/**
 * GET /api/surveys/[token]/review
 *
 * Tracked hop between the survey reward screen and the center's Google review
 * form. The CTA links HERE rather than straight at Google so the click is
 * always recorded: the CTA opens in a new tab (the gift-card screen holds the
 * QR, GAN and promo code, so we must not navigate the guest away from it), and
 * a client-side beacon on a new-tab click is exactly the case that gets
 * dropped. A server redirect can't be.
 *
 * Sentiment is re-checked HERE against the stored responses, not trusted from
 * the client. `isPositiveSentiment` is the single definition of a happy guest,
 * shared with the UI that decides whether to render the CTA at all — so a
 * hand-crafted URL can't harvest the review link, and the touch we record
 * stays truthful.
 *
 * 400 → bad token shape
 * 404 → unknown token
 * 302 → the center's Google review URL (happy path), or the brand home when
 *       the survey isn't complete, isn't positive, or the center has no
 *       mapped review destination. Never an error page: this is a link a
 *       guest tapped, so the worst case should still land somewhere sane.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!token || token.length < 8 || token.length > 64) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }

  const survey = await getGuestSurveyByToken(token);
  if (!survey) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Relative to the request, so a HeadPinz visitor lands on the HeadPinz home
  // and a FastTrax visitor on the FastTrax home without us resolving brand.
  const home = new URL("/", req.url);

  // A review click before the survey is submitted is nonsense — there are no
  // answers to gate on yet.
  if (!survey.completedAt) {
    return NextResponse.redirect(home, 302);
  }

  const answers = toAnswerMap(survey.responses);
  if (!isPositiveSentiment(survey.questions, answers)) {
    return NextResponse.redirect(home, 302);
  }

  const reviewUrl = googleReviewUrl(survey.centerCode);
  if (!reviewUrl) {
    console.warn(`[surveys/${token}/review] no review destination for center ${survey.centerCode}`);
    return NextResponse.redirect(home, 302);
  }

  // marketing_touches 'converted' with review metadata — fire-and-forget,
  // matching the `stage: "reward_issued"` shape the reward route records, so
  // the existing admin stats endpoints pick this up with no schema change.
  recordTouch({
    customerId: survey.squareCustomerId,
    phoneE164: survey.phoneE164,
    campaign: "guest_survey",
    event: "converted",
    refId: token,
    meta: {
      stage: "review_click",
      origin: survey.origin,
      centerCode: survey.centerCode,
    },
  }).catch((err) => console.warn(`[surveys/${token}/review] recordTouch failed:`, err));

  return NextResponse.redirect(reviewUrl, 302);
}
