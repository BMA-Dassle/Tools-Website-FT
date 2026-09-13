import { withCrmRoute } from "~/features/crm/core/http";
import { CallsListQuerySchema, boolFlag, loadCallsBoard } from "~/features/crm/calls";

/**
 * GET /api/admin/crm/calls?cursor=&limit=&rep=&direction=&needsDisposition=&missed=
 *   → `{ok, calls, nextCursor, tray, stats, connectivity, reps}`
 *
 * Everything the Calls screen draws in ONE round trip: the keyset page of calls
 * (`limit ≤ 200`, R10), the unclaimed-caller tray, the three tiles for the ET
 * calendar day, and an honest connectivity report — reads work today, the
 * journal needs `CRM_3CX_SECRET`, which is not set (see `docs/crm/3cx.md`).
 *
 * A rep always sees their own calls; `rep=` is honoured for a director only,
 * enforced in `scopeRepId`, not here.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(CallsListQuerySchema, async ({ input, user }) =>
  loadCallsBoard(user, {
    cursor: input.cursor ?? null,
    limit: input.limit,
    repId: input.rep ?? null,
    direction: input.direction,
    needsDisposition: boolFlag(input.needsDisposition),
    missedOnly: boolFlag(input.missed),
  }),
);
