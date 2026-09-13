import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import {
  ColdListActionSchema,
  ColdListIdSchema,
  ColdListNotFoundError,
  ColdListQuerySchema,
  buildReport,
  commitColdList,
  loadColdListBoard,
  mapColdList,
  updateColdList,
} from "~/features/crm/cold";

/**
 * GET  /api/admin/crm/cold/[id]?filter=&cursor=&limit=
 *        → `{ok, list, rows, nextCursor, next, reps}` — the dialling list
 *          (`crm-shared.js:439-441`), keyset-paged (R10).
 *
 * POST /api/admin/crm/cold/[id]
 *        {action:"map", columnMap}   → project every stored record and
 *                                      de-duplicate; returns the review report
 *        {action:"commit", decisions}→ apply the operator's link / skip / new
 *                                      choices and open the list for dialling
 *        {action:"update", …}        → rename, re-owner, set the centre
 *        {action:"archive", archived}→ hide it from the lists screen (the rows
 *                                      are kept; nothing is ever deleted)
 *
 * `maxDuration = 60`: a mapping pass walks up to `COLD_MAX_ROWS` rows in pages
 * of 500, one candidate query and one bulk UPDATE per page. The default
 * function timeout is shorter than that budget.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function listIdFrom(params: Record<string, string | string[]>): string {
  const raw = Array.isArray(params.id) ? params.id[0] : params.id;
  const parsed = ColdListIdSchema.safeParse(raw ?? "");
  if (!parsed.success) throw new CrmHttpError(404, "cold_list_not_found");
  return parsed.data;
}

function notFound(err: unknown): never {
  if (err instanceof ColdListNotFoundError) throw new CrmHttpError(404, err.message);
  throw err;
}

export const GET = withCrmRoute(ColdListQuerySchema, async ({ input, params }) => {
  const id = listIdFrom(params);
  return loadColdListBoard(id, {
    filter: input.filter,
    cursor: input.cursor ?? null,
    limit: input.limit,
  }).catch(notFound);
});

export const POST = withCrmRoute(ColdListActionSchema, async ({ input, params, user }) => {
  const id = listIdFrom(params);

  if (input.action === "map") {
    const { list, report } = await mapColdList(id, input.columnMap, user).catch(notFound);
    return { list, report };
  }

  if (input.action === "commit") {
    const out = await commitColdList(id, input.decisions ?? [], user).catch(notFound);
    return out;
  }

  if (input.action === "update") {
    const list = await updateColdList(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.ownerRepId !== undefined ? { ownerRepId: input.ownerRepId } : {}),
      ...(input.centre !== undefined ? { centre: input.centre } : {}),
    });
    if (!list) throw new CrmHttpError(404, "cold_list_not_found");
    await writeAudit({
      entity: "cold_list",
      entityId: id,
      action: "update",
      actorEmail: user.email,
      after: { name: input.name, ownerRepId: input.ownerRepId, centre: input.centre },
    });
    return { list, report: await buildReport(id) };
  }

  const list = await updateColdList(id, { archived: input.archived });
  if (!list) throw new CrmHttpError(404, "cold_list_not_found");
  await writeAudit({
    entity: "cold_list",
    entityId: id,
    action: input.archived ? "archive" : "restore",
    actorEmail: user.email,
    after: { archived: input.archived },
  });
  return { list, report: await buildReport(id) };
});
