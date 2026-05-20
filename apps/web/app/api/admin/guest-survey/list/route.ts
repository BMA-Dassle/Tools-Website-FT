import { NextRequest, NextResponse } from "next/server";
import {
  listGuestSurveys,
  type GuestSurveyListItem,
  type SurveyOrigin,
  type SurveyRewardKind,
} from "@/lib/guest-survey-db";
import { normalizePhoneE164 } from "~/features/marketing";

/**
 * GET /api/admin/guest-survey/list
 *
 * Admin-gated read-only listing of guest surveys with their gift-card
 * promo codes joined. Powers the portal's recent-activity table and
 * CSV exports.
 *
 * Auth: middleware enforces ADMIN_CAMERA_TOKEN via header
 * `x-admin-token` or `?token=`.
 *
 * Query params (all optional):
 *   - limit          number    default 50, max 500
 *   - offset         number    default 0
 *   - since          ISO       lower bound on sent_at
 *   - until          ISO       upper bound on sent_at
 *   - centerCode     string    e.g. "TXBSQN0FEKQ11"
 *   - origin         bowling|racing
 *   - tag            string    survey must include this tag (baseline,
 *                              bowling, fnb_service, closing, etc.)
 *   - rewardKind     pinz|gift_card|declined
 *   - hasResponses   true|false — only submitted surveys
 *   - hasReward      true|false — only surveys that issued a reward
 *   - completedOnly  alias of hasResponses (back-compat)
 *   - format         json|csv  default json
 *
 * Response includes a `squareDashboardUrl` per row so the spreadsheet
 * can link straight to the customer's Square profile.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const truthy = (v: string | null) => (v ?? "").toLowerCase() === "true";

  const limit = Math.min(Math.max(Number(sp.get("limit") ?? 50), 1), 500);
  const offset = Math.max(Number(sp.get("offset") ?? 0), 0);
  const since = sp.get("since") || null;
  const until = sp.get("until") || null;
  const centerCode = sp.get("centerCode") || null;
  const origin = (sp.get("origin") as SurveyOrigin | null) || null;
  const tag = sp.get("tag") || null;
  const rewardKind = (sp.get("rewardKind") as SurveyRewardKind | null) || null;
  const hasResponses = sp.get("hasResponses") != null ? truthy(sp.get("hasResponses")) : null;
  const hasReward = sp.get("hasReward") != null ? truthy(sp.get("hasReward")) : null;
  const completedOnly = truthy(sp.get("completedOnly"));
  const format = (sp.get("format") ?? "json").toLowerCase();
  const squareCustomerId = sp.get("squareCustomerId") || null;
  let phoneE164: string | null = null;
  const phoneInput = sp.get("phone");
  if (phoneInput) {
    try {
      phoneE164 = normalizePhoneE164(phoneInput);
    } catch {
      return NextResponse.json({ error: "invalid phone" }, { status: 400 });
    }
  }

  let rows: GuestSurveyListItem[];
  try {
    rows = await listGuestSurveys({
      since,
      until,
      centerCode,
      origin,
      tag,
      rewardKind,
      hasResponses,
      hasReward,
      phoneE164,
      squareCustomerId,
      completedOnly,
      limit,
      offset,
    });
  } catch (err) {
    console.error("[admin-debug] guest-survey/list failed:", err);
    return NextResponse.json(
      { error: "list failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  const enriched = rows.map((r) => ({
    ...r,
    // Drill-down links the portal can render directly.
    squareDashboardUrl: `https://app.squareup.com/dashboard/customers/${r.squareCustomerId}`,
    surveyResultUrl: `https://headpinz.com/survey/${r.token}`,
    squareGiftCardDashboardUrl: r.promoCodeGiftCardId
      ? `https://app.squareup.com/dashboard/gift-cards/${r.promoCodeGiftCardId.replace(/^gftc:/, "")}`
      : null,
  }));

  if (format === "csv") {
    const csv = toCsv(enriched);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="guest-surveys-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    count: enriched.length,
    limit,
    offset,
    filters: {
      since,
      until,
      centerCode,
      origin,
      tag,
      rewardKind,
      hasResponses,
      hasReward,
      phoneE164,
      squareCustomerId,
    },
    surveys: enriched,
  });
}

// ─────────────────────────────────────────────────────────────────
// CSV serialization — flat one-row-per-survey
// ─────────────────────────────────────────────────────────────────

const CSV_COLUMNS: Array<{ header: string; pick: (r: EnrichedRow) => unknown }> = [
  { header: "token", pick: (r) => r.token },
  { header: "sent_at", pick: (r) => r.sentAt },
  { header: "opened_at", pick: (r) => r.openedAt },
  { header: "completed_at", pick: (r) => r.completedAt },
  { header: "origin", pick: (r) => r.origin },
  { header: "origin_ref", pick: (r) => r.originRef },
  { header: "center_code", pick: (r) => r.centerCode },
  { header: "visit_date", pick: (r) => r.visitDate },
  { header: "phone_e164", pick: (r) => r.phoneE164 },
  { header: "square_customer_id", pick: (r) => r.squareCustomerId },
  { header: "square_dashboard_url", pick: (r) => r.squareDashboardUrl },
  { header: "reward_kind", pick: (r) => r.rewardKind },
  { header: "reward_value", pick: (r) => r.rewardValue },
  { header: "reward_ref", pick: (r) => r.rewardRef },
  { header: "promo_code", pick: (r) => r.promoCode },
  { header: "promo_gift_card_id", pick: (r) => r.promoCodeGiftCardId },
  { header: "promo_gan", pick: (r) => r.promoCodeGan },
  { header: "promo_redeemed_at", pick: (r) => r.promoCodeRedeemedAt },
  { header: "square_gift_card_dashboard_url", pick: (r) => r.squareGiftCardDashboardUrl },
  { header: "survey_result_url", pick: (r) => r.surveyResultUrl },
  { header: "questions_json", pick: (r) => JSON.stringify(r.questions) },
  { header: "responses_json", pick: (r) => (r.responses ? JSON.stringify(r.responses) : null) },
  { header: "context_json", pick: (r) => JSON.stringify(r.context) },
];

type EnrichedRow = GuestSurveyListItem & {
  squareDashboardUrl: string;
  surveyResultUrl: string;
  squareGiftCardDashboardUrl: string | null;
};

function toCsv(rows: EnrichedRow[]): string {
  const header = CSV_COLUMNS.map((c) => c.header).join(",");
  const body = rows.map((r) => CSV_COLUMNS.map((c) => csvCell(c.pick(r))).join(",")).join("\n");
  return header + "\n" + body + (body ? "\n" : "");
}

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  // Quote if it contains comma, quote, or newline. Escape inner quotes by doubling.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
