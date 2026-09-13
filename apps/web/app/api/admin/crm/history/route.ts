import { HistoryQuerySchema, historySearch } from "~/features/crm/bmi";
import { withCrmRoute } from "~/features/crm/core/http";

/**
 * GET /api/admin/crm/history?q=&limit=&accountsCursor=&eventsCursor= (wire contract)
 *   → `{ok, q, accounts, accountsNextCursor, events, eventsNextCursor, mirror}`
 *
 * The History screen's one read: accounts matching `q` by name, contact,
 * phone digits or email (the most recently created when `q` is empty), the
 * mirrored EVENTS matching `q` (only when `q` is given), and the mirror's
 * own state (row counts + the latest sync runs) so the screen can say when
 * the mirror has never been filled. Keyset cursors, `limit ≤ 200` (R10).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(HistoryQuerySchema, async ({ input }) =>
  historySearch({
    q: input.q,
    limit: input.limit,
    accountsCursor: input.accountsCursor ?? null,
    eventsCursor: input.eventsCursor ?? null,
  }),
);
