/**
 * Click-to-call: the rep presses Call, their 3CX extension rings, then the
 * guest's phone does ("Ringing your 3CX extension (141) first, then …" —
 * `crm-shared.js:253`).
 *
 * ORDER OF OPERATIONS IS THE POINT (R2, "Neon first, external second"). The
 * `crm_calls` intent row is written BEFORE 3CX is asked for anything, so a call
 * the PBX refuses is still on the rep's board with the number they meant to
 * ring, and so is a call that connects but whose CDR never reaches us. The
 * reconcile job later merges the real call onto whatever it can match.
 *
 * IT DEGRADES INSTEAD OF FAILING. Three things can stop the PBX ringing:
 * `CRM_CALLS=false` (the kill switch), no credential, or the rep having no
 * `threecx_extension` — plus the PBX simply refusing. None of them is an error
 * for the rep: every response carries a `tel:` href and an `outcome`, and the
 * sheet hands them their phone with the reason. `makeCall` was deliberately
 * never probed live (a probe would have rung a real handset,
 * `docs/crm/3cx.md`), so "the PBX refuses" is a case we assume WILL happen on
 * day one and have tested.
 */

import { crmCallsEnabled } from "../../core/flags";
import { recordActivity } from "../../activities";
import type { CrmUser, Direction } from "../../core/types";
import { upsertCall } from "../data/calls-db";
import type { CallRow, DialOutcome } from "../contracts";
import { matchNumber, toE164 } from "./match";
import { makeCall, threecxConfigured } from "./threecx";

export interface DialInput {
  /** E.164 or anything a human typed; normalised here. */
  number: string;
  /** The lead the rep was looking at, when there was one. */
  leadId?: string | null;
  user: CrmUser;
}

export interface DialDeps {
  save: typeof upsertCall;
  match: typeof matchNumber;
  ring: typeof makeCall;
  activity: typeof recordActivity;
  configured: typeof threecxConfigured;
  enabled: typeof crmCallsEnabled;
  now: () => Date;
}

export const defaultDialDeps: DialDeps = {
  save: upsertCall,
  match: matchNumber,
  ring: makeCall,
  activity: recordActivity,
  configured: threecxConfigured,
  enabled: crmCallsEnabled,
  now: () => new Date(),
};

export interface DialResult {
  call: CallRow | null;
  outcome: DialOutcome;
  telHref: string;
  error: string | null;
}

/** Why the PBX was not asked, in the rep's words. Null = it was asked. */
export function dialBlockedReason(
  user: CrmUser,
  deps: Pick<DialDeps, "configured" | "enabled">,
): string | null {
  if (!deps.enabled()) return "Click-to-call is switched off";
  if (!deps.configured()) return "3CX is not configured";
  if (!user.rep?.threecxExtension) return "No 3CX extension on your rep record";
  return null;
}

export const DIAL_RING_SECONDS = 30;

export async function startCall(
  input: DialInput,
  deps: DialDeps = defaultDialDeps,
): Promise<DialResult> {
  const e164 = toE164(input.number);
  const telHref = `tel:${e164 ?? input.number}`;
  const now = deps.now();
  const direction: Direction = "out";
  const extension = input.user.rep?.threecxExtension ?? null;

  // 1. Neon first — the intent exists whatever 3CX says next.
  const match = await deps.match(e164);
  const leadId = input.leadId ?? match.leadId;
  const call = await deps.save({
    direction,
    toE164: e164,
    extension,
    repId: input.user.rep?.id ?? match.repId,
    leadId,
    contactId: match.contactId,
    startedAt: now,
    status: "Dialing",
    source: "click",
    actorEmail: input.user.email,
    raw: { requested: input.number },
  });

  // 2. External second.
  const blocked = dialBlockedReason(input.user, deps);
  if (blocked || !extension) {
    return { call, outcome: "disabled", telHref, error: blocked ?? "No 3CX extension" };
  }

  let outcome: DialOutcome = "ringing";
  let error: string | null = null;
  try {
    await deps.ring(extension, e164 ?? input.number, DIAL_RING_SECONDS);
  } catch (err) {
    outcome = "fallback";
    error = err instanceof Error ? err.message : String(err);
  }

  // 3. The diary, which never throws for the caller's sake.
  await deps.activity({
    leadId: leadId ?? null,
    contactId: match.contactId,
    repId: input.user.rep?.id ?? null,
    actorEmail: input.user.email,
    kind: "call",
    direction,
    occurredAt: now,
    outcome: outcome === "ringing" ? "Dialed" : "Dial failed",
    body: outcome === "ringing" ? null : error,
    externalKind: "crm-dial",
    externalRef: call ? `call:${call.id}` : null,
    meta: { number: e164, extension },
  });

  return { call, outcome, telHref, error };
}
