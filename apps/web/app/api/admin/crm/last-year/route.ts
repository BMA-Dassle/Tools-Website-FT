import { LastYearQuerySchema, lastYearHosts } from "~/features/crm/bmi";
import { withCrmRoute } from "~/features/crm/core/http";

/**
 * GET /api/admin/crm/last-year?clientKey=&limit=&cursor= (wire contract)
 *   → `{ok, window: {from, till}, items, nextCursor}`
 *
 * "This time last year": group events that happened 3–8 weeks from today,
 * one year ago, whose host has not come back — no open CRM lead and no later
 * Office project by account, phone or email. Oldest first; keyset cursor.
 * The window is ET calendar days (`lastYearWindow`, R10).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(LastYearQuerySchema, async ({ input }) =>
  lastYearHosts({ clientKey: input.clientKey, limit: input.limit, cursor: input.cursor ?? null }),
);
