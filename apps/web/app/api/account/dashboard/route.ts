import { requireSession } from "~/features/account/service/session";
import { buildDashboard } from "~/features/account/service/dashboard";
import { jsonOk, toErrorResponse } from "~/features/account/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/account/dashboard — the logged-in customer's aggregated view:
 * reservations, group events, HeadPinz Rewards, and BMI race account.
 * Read-only ⇒ no CSRF (requireCsrf guards mutations only). buildDashboard
 * degrades per-section, so once the session is valid this never 500s.
 */
export async function GET() {
  try {
    const session = await requireSession();
    const data = await buildDashboard(session);
    return jsonOk(data as unknown as Record<string, unknown>);
  } catch (err) {
    return toErrorResponse(err);
  }
}
