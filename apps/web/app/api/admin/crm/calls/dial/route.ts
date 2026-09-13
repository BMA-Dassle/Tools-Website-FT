import { writeAudit } from "~/features/crm/core/data/audit-db";
import { withCrmRoute } from "~/features/crm/core/http";
import { CallDialSchema, startCall } from "~/features/crm/calls";
import { leadNumericId } from "~/features/crm/leads";

/**
 * POST /api/admin/crm/calls/dial
 *   {number, leadId?} → `{ok, call, outcome, telHref, error}`
 *
 * Rings the signed-in rep's 3CX extension first, then the guest
 * (`POST /callcontrol/{ext}/makecall`) — the prototype's "Ringing your 3CX
 * extension (141) first, then …".
 *
 * NEVER FAILS THE REP. The `crm_calls` intent row is written before 3CX is
 * asked anything (R2), and `outcome` says what happened: `ringing`, `fallback`
 * (the PBX refused — the sheet offers `telHref`), or `disabled` (`CRM_CALLS` is
 * off, no credential, or no extension on the rep's record). A 500 here would
 * mean the rep lost both the call and the record of trying.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withCrmRoute(CallDialSchema, async ({ input, user }) => {
  const leadId = input.leadId ? leadNumericId(input.leadId) : null;
  const result = await startCall({ number: input.number, leadId, user });
  await writeAudit({
    entity: "call",
    entityId: result.call?.id ?? "unsaved",
    action: "dial",
    actorEmail: user.email,
    after: {
      outcome: result.outcome,
      leadId,
      extension: user.rep?.threecxExtension ?? null,
      error: result.error,
    },
  });
  return {
    call: result.call,
    outcome: result.outcome,
    telHref: result.telHref,
    error: result.error,
  };
});
