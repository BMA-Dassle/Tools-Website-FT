import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import { getLead, leadNumericId } from "~/features/crm/leads";
import { LeadStatusSchema } from "~/features/crm/statuses";
// `service/transition` is imported by path, not through the sub's barrel —
// see the header of `statuses/index.ts` for why (it would close a cycle
// statuses → leads → statuses and deadlock `ensureCrmSchema`).
import {
  StatusNotFoundError,
  StatusUnchangedError,
  transition,
} from "~/features/crm/statuses/service/transition";

/**
 * POST /api/admin/crm/leads/[id]/status
 *   {statusId, lostReason?, note?} → `{ok, lead, status, from, bmi}`
 *
 * The board's drag and the deal's status sheet both land here. `transition()`
 * writes Neon FIRST and then, only when the status is mapped for this tenant
 * and writes are on, the Office state through PR1's `putProjectFields` — one
 * writer per project, per-project Redis lock, verified by re-read.
 *
 * `bmi.status` says which branch ran: write · unmapped · paused · no_project ·
 * builtin · pending. The caller shows the matching chip; nothing is claimed
 * that Office did not confirm.
 *
 * Any rep may move their own lead; a director may move anyone's — the same
 * rule the board itself applies, and the lead's own rep column is what the
 * board reads, so no extra gate is needed here beyond the sales role.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withCrmRoute(LeadStatusSchema, async ({ input, params, user }) => {
  const raw = Array.isArray(params.id) ? params.id[0] : params.id;
  const id = raw ? leadNumericId(raw) : null;
  if (!id) throw new CrmHttpError(404, "lead_not_found");
  const lead = await getLead(id);
  if (!lead) throw new CrmHttpError(404, "lead_not_found");

  try {
    const result = await transition({
      lead,
      toStatusId: input.statusId,
      actor: user.email,
      lostReason: input.lostReason ?? null,
      note: input.note ?? null,
    });
    await writeAudit({
      entity: "lead",
      entityId: result.lead.id,
      action: "status",
      actorEmail: user.email,
      before: { status: result.from, bmiStateId: lead.bmi.stateId },
      after: { status: result.status.id, bmi: result.bmi },
    });
    return {
      lead: result.lead,
      status: result.status,
      from: result.from,
      bmi: result.bmi,
    };
  } catch (err) {
    if (err instanceof StatusNotFoundError) throw new CrmHttpError(400, "unknown_status");
    if (err instanceof StatusUnchangedError) throw new CrmHttpError(409, "status_unchanged");
    throw err;
  }
});
