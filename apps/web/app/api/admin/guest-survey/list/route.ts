import { NextRequest, NextResponse } from "next/server";
import { listGuestSurveys, type GuestSurveyListItem } from "@/lib/guest-survey-db";

/**
 * GET /api/admin/guest-survey/list
 *
 * Admin-gated read-only listing of recent guest surveys with their
 * gift-card promo codes joined. Powers ops reporting until the full
 * admin UI (PR-GS6) lands.
 *
 * Auth: middleware enforces ADMIN_CAMERA_TOKEN via header `x-admin-token`
 * or `?token=`.
 *
 * Query params:
 *   - limit         number  default 50, max 500
 *   - since         ISO     default NULL (no lower bound); accepts YYYY-MM-DD or full timestamp
 *   - centerCode    string  optional exact match (e.g. "TXBSQN0FEKQ11")
 *   - completedOnly bool    default false — set "true" to only return submitted rows
 *   - format        json|csv — default json. CSV is one-row-per-survey, with
 *                              questions_json / responses_json / context_json
 *                              kept as JSON-string columns.
 *
 * Response includes a `squareDashboardUrl` per row so the spreadsheet
 * can link straight to the customer's Square profile.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  const limit = Math.min(Math.max(Number(sp.get("limit") ?? 50), 1), 500);
  const since = sp.get("since") || null;
  const centerCode = sp.get("centerCode") || null;
  const completedOnly = (sp.get("completedOnly") ?? "").toLowerCase() === "true";
  const format = (sp.get("format") ?? "json").toLowerCase();

  let rows: GuestSurveyListItem[];
  try {
    rows = await listGuestSurveys({ since, centerCode, completedOnly, limit });
  } catch (err) {
    console.error("[admin-debug] guest-survey/list failed:", err);
    return NextResponse.json(
      { error: "list failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  const enriched = rows.map((r) => ({
    ...r,
    squareDashboardUrl: `https://app.squareup.com/dashboard/customers/${r.squareCustomerId}`,
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

  return NextResponse.json({ ok: true, count: enriched.length, surveys: enriched });
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
  { header: "promo_gan", pick: (r) => r.promoCodeGan },
  { header: "promo_redeemed_at", pick: (r) => r.promoCodeRedeemedAt },
  { header: "questions_json", pick: (r) => JSON.stringify(r.questions) },
  { header: "responses_json", pick: (r) => (r.responses ? JSON.stringify(r.responses) : null) },
  { header: "context_json", pick: (r) => JSON.stringify(r.context) },
];

type EnrichedRow = GuestSurveyListItem & { squareDashboardUrl: string };

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
