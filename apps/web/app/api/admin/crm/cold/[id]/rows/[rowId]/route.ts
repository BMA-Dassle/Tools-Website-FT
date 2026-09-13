import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import {
  ColdRowActionSchema,
  ColdRowIdSchema,
  ColdRowNotFoundError,
  applyColdDisposition,
  convertColdRow,
  getColdList,
  getColdRow,
  setColdRowDecision,
} from "~/features/crm/cold";

/**
 * POST /api/admin/crm/cold/[id]/rows/[rowId]
 *   {action:"disposition", disposition, note?, callbackAt?}
 *       → the outcome, plus a `crm_activities` row with `kind:'call'` so
 *         Accountability and the KPI screens count it with no special case
 *   {action:"convert", draft}
 *       → the prospect becomes a lead: `createLead` mints the BMI project and
 *         the assignment rules run (brief §5.7b assign-at-capture). NOTHING is
 *         minted before this moment — a cold row is a prospect.
 *   {action:"decision", decision}
 *       → the operator changing link / skip / new on a matched row
 *
 * There is no "text" action, by design: a cold row never gave us its number for
 * an enquiry, so no consent basis exists (R8, `docs/crm/README.md`).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withCrmRoute(ColdRowActionSchema, async ({ input, params, user }) => {
  const raw = Array.isArray(params.rowId) ? params.rowId[0] : params.rowId;
  const parsed = ColdRowIdSchema.safeParse(raw ?? "");
  if (!parsed.success) throw new CrmHttpError(404, "cold_row_not_found");
  const rowId = parsed.data;

  const missing = (err: unknown): never => {
    if (err instanceof ColdRowNotFoundError) throw new CrmHttpError(404, err.message);
    throw err;
  };

  if (input.action === "disposition") {
    const result = await applyColdDisposition({
      rowId,
      disposition: input.disposition,
      note: input.note ?? null,
      callbackAt: input.callbackAt ?? null,
      user,
    }).catch(missing);
    const list = await getColdList(result.row.listId);
    if (!list) throw new CrmHttpError(404, "cold_list_not_found");
    await writeAudit({
      entity: "cold_row",
      entityId: result.row.id,
      action: "disposition",
      actorEmail: user.email,
      after: {
        disposition: input.disposition,
        listId: result.row.listId,
        callbackAt: result.row.callbackAt,
      },
    });
    return { row: result.row, list, converted: false };
  }

  if (input.action === "convert") {
    const result = await convertColdRow({
      rowId,
      draft: {
        centre: input.draft.centre,
        eventDate: input.draft.eventDate,
        eventTime: input.draft.eventTime ?? null,
        guests: input.draft.guests,
        type: input.draft.type,
        firstName: input.draft.firstName,
        lastName: input.draft.lastName,
        phone: input.draft.phone ?? null,
        email: input.draft.email ?? null,
        company: input.draft.company ?? null,
        notes: input.draft.notes ?? null,
      },
      note: input.note ?? null,
      user,
    }).catch(missing);
    const list = await getColdList(result.row.listId);
    if (!list) throw new CrmHttpError(404, "cold_list_not_found");
    await writeAudit({
      entity: "cold_row",
      entityId: result.row.id,
      action: "convert",
      actorEmail: user.email,
      after: {
        leadId: result.leadId,
        leadPublicId: result.leadPublicId,
        mintStatus: result.mintStatus,
        created: result.created,
      },
    });
    return {
      row: result.row,
      list,
      leadId: result.leadId,
      leadPublicId: result.leadPublicId,
      mintStatus: result.mintStatus,
      mintError: result.mintError,
      assignedRepName: result.assignedRepName,
    };
  }

  await setColdRowDecision(rowId, input.decision);
  const row = await getColdRow(rowId);
  if (!row) throw new CrmHttpError(404, "cold_row_not_found");
  const list = await getColdList(row.listId);
  if (!list) throw new CrmHttpError(404, "cold_list_not_found");
  return { row, list, converted: false };
});
