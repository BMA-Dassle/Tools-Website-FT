import { HistoryQuerySchema, historySearch } from "~/features/crm/bmi";
import { withCrmRoute } from "~/features/crm/core/http";

/**
 * GET /api/admin/crm/history?q=&limit=&accountsCursor=&eventsCursor=&accounts=0&events=0&status=0
 *   → `{ok, q, accounts, accountsNextCursor, events, eventsNextCursor, mirror}`
 *
 * The History screen's one read: accounts matching `q` by name, contact,
 * phone digits or email (the most recently created when `q` is empty), the
 * mirrored EVENTS matching `q` (only when `q` is given), and the mirror's
 * own state (row counts + the latest sync runs) so the screen can say when
 * the mirror has never been filled. Keyset cursors, `limit ≤ 200` (R10).
 *
 * The two lists page INDEPENDENTLY: `accounts=0` / `events=0` say "that one is
 * finished", so a "Load more" never re-reads a list that has run out (and the
 * screen never shows its rows twice). `status=0` skips the mirror counts,
 * which the screen needs once per mount, not once per page.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(HistoryQuerySchema, async ({ input }) =>
  historySearch({
    q: input.q,
    limit: input.limit,
    accountsCursor: input.accountsCursor ?? null,
    eventsCursor: input.eventsCursor ?? null,
    accounts: input.accounts,
    events: input.events,
    status: input.status,
  }),
);
