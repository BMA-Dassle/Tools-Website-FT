/**
 * "When the call ends" — the six outcomes and what each one does
 * (`crm-shared.js:256,259` `act("dispo")`).
 *
 * The prototype's whole behaviour, made real:
 *   - append a `call` activity with the outcome and the rep's note;
 *   - `if (!l.firstTouchAt) l.firstTouchAt = now` → B3's `recordFirstTouch`,
 *     which only counts when the toucher IS the assignee and only sets it once;
 *   - `if (l.status === "assigned") l.status = "contacted"` → a real status
 *     write, guarded so it can only ever move that one step;
 *   - `if (o === "Reached") l.nextAction = null` → the follow-up is cleared
 *     when the rep actually spoke to them, and left alone otherwise.
 *
 * WHY THE STATUS MOVE IS SAFE TO DO HERE. B4 owns pipeline transitions and the
 * BMI state write that goes with them; this is not that. It is the single
 * `assigned → contacted` hop the prototype performs on a disposition, written
 * through the leads sub's own `updateLeadFields` (never raw SQL), and it fires
 * ONLY from `assigned`. When B4's transition service lands it replaces the one
 * call below; nothing else here changes.
 */

import { getLead, recordFirstTouch, updateLeadFields } from "../../leads";
import { recordActivity } from "../../activities";
import type { CrmUser } from "../../core/types";
import { getCall, setCallDisposition } from "../data/calls-db";
import { CALL_DISPOSITIONS, type CallDisposition, type CallRow } from "../contracts";

export { CALL_DISPOSITIONS };

/**
 * A service throws this, not a `CrmHttpError`: `core/http` imports
 * `next/server`, and dragging the whole Next request runtime into every module
 * that merely wants to say "no such row" is a cost paid by everything that
 * imports this sub's barrel — `core/schema.ts` included. The route maps it.
 */
export class CallNotFoundError extends Error {
  constructor(readonly callId: string) {
    super("call_not_found");
    this.name = "CallNotFoundError";
  }
}

/** The outcome that means a human spoke to a human. */
export const REACHED: CallDisposition = "Reached";

/** The status a lead moves to on its first logged call, and the only one it moves FROM. */
export const STATUS_BEFORE_CONTACT = "assigned";
export const STATUS_AFTER_CONTACT = "contacted";

export interface DispositionInput {
  callId: string;
  disposition: CallDisposition;
  note?: string | null;
  user: CrmUser;
  at?: Date;
}

export interface DispositionDeps {
  read: typeof getCall;
  write: typeof setCallDisposition;
  lead: typeof getLead;
  patchLead: typeof updateLeadFields;
  firstTouch: typeof recordFirstTouch;
  activity: typeof recordActivity;
}

export const defaultDispositionDeps: DispositionDeps = {
  read: getCall,
  write: setCallDisposition,
  lead: getLead,
  patchLead: updateLeadFields,
  firstTouch: recordFirstTouch,
  activity: recordActivity,
};

export interface DispositionResult {
  call: CallRow;
  firstTouchRecorded: boolean;
  leadStatus: string | null;
}

/**
 * Which lead patch a disposition implies. PURE, so the rules are tested without
 * a database: a "Reached" on an `assigned` lead both advances the status and
 * clears the follow-up; every other outcome leaves the next action where it is.
 */
export function leadPatchFor(
  disposition: CallDisposition,
  lead: { status: string; nextAction: unknown },
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (lead.status === STATUS_BEFORE_CONTACT) patch.statusId = STATUS_AFTER_CONTACT;
  if (disposition === REACHED && lead.nextAction) {
    patch.nextActionKind = null;
    patch.nextActionDue = null;
    patch.nextActionLabel = null;
  }
  return patch;
}

/**
 * Record the outcome. The call row is written FIRST and unconditionally — a
 * lead that has since been archived, or a call that was never matched to one,
 * still gets its disposition, because the rep did the work either way.
 */
export async function applyDisposition(
  input: DispositionInput,
  deps: DispositionDeps = defaultDispositionDeps,
): Promise<DispositionResult> {
  const existing = await deps.read(input.callId);
  if (!existing) throw new CallNotFoundError(input.callId);

  const at = input.at ?? new Date();
  const note = (input.note ?? "").trim() || null;
  const call = await deps.write(input.callId, {
    disposition: input.disposition,
    note,
    actorEmail: input.user.email,
    at,
  });
  if (!call) throw new CallNotFoundError(input.callId);

  await deps.activity({
    leadId: call.leadId,
    contactId: call.contactId,
    repId: call.repId,
    actorEmail: input.user.email,
    kind: "call",
    direction: call.direction,
    occurredAt: call.startedAt ?? at,
    durationSeconds: call.durationSeconds,
    outcome: input.disposition,
    body: note,
    externalKind: "crm-call-disposition",
    externalRef: `call:${call.id}`,
    meta: { threecxCallId: call.threecxCallId, extension: call.extension },
  });

  if (!call.leadId) return { call, firstTouchRecorded: false, leadStatus: null };

  const lead = await deps.lead(call.leadId);
  if (!lead) return { call, firstTouchRecorded: false, leadStatus: null };

  // An OUTBOUND call by the assignee is a first touch; an inbound one is the
  // guest reaching us, which is not the rep's response time (R: response-time
  // counts outbound touches only, `leads/response-badge.ts`).
  let firstTouchRecorded = false;
  if (call.direction === "out" && lead.rep && call.repId === lead.rep) {
    const touch = await deps.firstTouch({
      leadId: lead.id,
      repId: lead.rep,
      at: call.startedAt ? new Date(call.startedAt) : at,
    });
    firstTouchRecorded = touch.recorded;
  }

  const patch = leadPatchFor(input.disposition, lead);
  if (Object.keys(patch).length === 0) {
    return { call, firstTouchRecorded, leadStatus: lead.status };
  }
  const updated = await deps.patchLead(lead.id, patch);
  return { call, firstTouchRecorded, leadStatus: updated?.status ?? lead.status };
}
