import { withCrmRoute } from "~/features/crm/core/http";
import {
  ColdCreateSchema,
  ColdListsQuerySchema,
  boolFlag,
  createColdList,
  loadColdListsBoard,
} from "~/features/crm/cold";

/**
 * GET  /api/admin/crm/cold?includeArchived=&owner=
 *        → `{ok, lists, reps}` — every cold list with its conversion counters
 *          (`crm-shared.js:442`).
 *
 * POST /api/admin/crm/cold  {action:"create", name, headers, …}
 *        → `{ok, list}` — the list row, created BEFORE a single record is
 *          posted. The rows follow as chunks on `cold/[id]/rows`, and the
 *          mapping is applied afterwards from what was stored: guest-supplied
 *          data is persisted at capture, never after the rest of the flow
 *          succeeds (CLAUDE.md; brief R2).
 *
 * There is no multipart upload here. The brief's "multipart CSV ≤ 5 MB" cannot
 * work on this deployment — Vercel refuses a request body over 4.5 MB — so the
 * browser parses the file with `~/features/crm/cold/csv` and posts records in
 * chunks, which also gives the mapping screen its headers with no round trip.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(ColdListsQuerySchema, async ({ input, user }) =>
  loadColdListsBoard(user, {
    includeArchived: boolFlag(input.includeArchived),
    ownerRepId: input.owner ?? null,
  }),
);

export const POST = withCrmRoute(ColdCreateSchema, async ({ input, user }) => {
  const list = await createColdList(
    {
      name: input.name,
      ownerRepId: input.ownerRepId ?? user.rep?.id ?? null,
      centre: input.centre ?? null,
      sourceFilename: input.sourceFilename ?? null,
      headers: input.headers,
      parseMeta: input.parseMeta ?? null,
      columnMap: input.columnMap ?? null,
    },
    user,
  );
  return { list };
});
