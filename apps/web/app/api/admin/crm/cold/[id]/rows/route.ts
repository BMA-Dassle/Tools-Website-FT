import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import {
  ColdListFullError,
  ColdListIdSchema,
  ColdListNotFoundError,
  ColdRowsAppendSchema,
  appendColdRows,
} from "~/features/crm/cold";

/**
 * POST /api/admin/crm/cold/[id]/rows  {records:[{index, values}]}
 *   → `{ok, inserted, rowCount}`
 *
 * THE PERSIST-AT-CAPTURE STEP. One chunk of the uploaded file, stored exactly
 * as it arrived in `crm_cold_rows.raw` — no mapping, no matching, no external
 * call. Everything else the importer does reads those rows back, so a browser
 * that dies during the mapping screen loses nothing and a mis-mapped list is
 * re-mapped instead of re-uploaded (CLAUDE.md "persist guest-provided data at
 * capture"; brief R2).
 *
 * Re-posting a chunk is a no-op: `(list_id, row_index)` is unique and the
 * insert is `ON CONFLICT DO NOTHING`, so a retry after a flaky connection
 * cannot double the list.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = withCrmRoute(ColdRowsAppendSchema, async ({ input, params, user }) => {
  const raw = Array.isArray(params.id) ? params.id[0] : params.id;
  const parsed = ColdListIdSchema.safeParse(raw ?? "");
  if (!parsed.success) throw new CrmHttpError(404, "cold_list_not_found");

  return appendColdRows(parsed.data, input.records, user).catch((err: unknown) => {
    if (err instanceof ColdListNotFoundError) throw new CrmHttpError(404, err.message);
    if (err instanceof ColdListFullError) throw new CrmHttpError(413, err.message);
    throw err;
  });
});
