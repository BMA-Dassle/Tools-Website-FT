/**
 * Minting the BMI project for a lead through Pandora's party-lead rail
 * (`lib/pandora-party-lead.ts`, the SAME call the web form has always made).
 *
 * THE MINT POLICY (brief §4 B3, from Pandora's own source, §1.6):
 *   (a) when a rep is already picked, `agent` = that rep's Office display
 *       name (`crm_reps.bmi_username`, the substring Pandora matches with
 *       `name.includes`) — `crm_assignments.reason = 'rule'` follows;
 *   (b) otherwise `agent: "First Available"` — NEVER undefined, which is a
 *       500 "Failed to assign an agent"; Pandora's own pick lands on the
 *       activity and the eventual `assign()` overwrites it through the
 *       responsible PUT;
 *   (c) the CRM `EventType` maps to Pandora's four strings below; `birthday`
 *       becomes "Child Birthday" ONLY when the lead is a kids' party, because
 *       Pandora force-routes that string to Guest Services regardless of
 *       `agent` (rule R2 agrees); adult birthdays send "Adult Birthday";
 *   (d) `email` and `eventTime` are REQUIRED by Pandora: a lead without them
 *       is `mint_status='none'`, `mint_error='needs_email_or_time'`, and the
 *       deal offers "Complete to create in BMI" — no placeholder emails.
 *
 * NEON FIRST (R2): the lead row already exists when this runs; success writes
 * `bmi_project_id / number / person_id` + `mint_status='minted'`, failure
 * writes `mint_status='failed'` + `mint_error` and enqueues `mint-bmi-project`.
 * Nothing here trusts a 200 without `projectID` in the body.
 */

import type { PandoraEventType } from "@/lib/sales-lead-config";
import {
  submitPartyLead,
  type PartyLeadInput,
  type PartyLeadResult,
} from "@/lib/pandora-party-lead";
import { recordActivity } from "~/features/crm/activities";
import { neonJobStore, type JobStore } from "~/features/crm/jobs";
import type { EventType } from "../../core/types";
import {
  CENTRE_TO_PANDORA_KEY,
  NEEDS_EMAIL_OR_TIME,
  type LeadView,
  type MintOutcomeView,
} from "../contracts";
import { bumpMintAttempt, getLead, updateLeadFields } from "../data/leads-db";

export { NEEDS_EMAIL_OR_TIME };

/** The tested constant — (c) above. `birthday` is resolved by `pandoraEventTypeFor`. */
export const EVENT_TYPE_TO_PANDORA: Record<Exclude<EventType, "birthday">, PandoraEventType> = {
  corporate: "Company Event",
  team: "Company Event",
  holiday: "Company Event",
  school: "Other Event",
  fundraiser: "Other Event",
};

export function pandoraEventTypeFor(type: EventType, kids: boolean): PandoraEventType {
  if (type === "birthday") return kids ? "Child Birthday" : "Adult Birthday";
  return EVENT_TYPE_TO_PANDORA[type];
}

export const FIRST_AVAILABLE = "First Available";
export const MINT_TIMEOUT_MS = 20_000;
export const MINT_JOB_KIND = "mint-bmi-project" as const;

/** Why a lead cannot be minted yet, or null when it can. */
export function mintBlocker(
  lead: Pick<LeadView, "guest" | "eventTime" | "isProspect">,
): string | null {
  if (lead.isProspect) return "prospect";
  if (!lead.guest.email || !lead.eventTime) return NEEDS_EMAIL_OR_TIME;
  return null;
}

export interface MintExtras {
  /** (a)/(b): the Office display name of the picked rep, or null for "First Available". */
  agent?: string | null;
  specialRequests?: string | null;
  packageType?: string | null;
  preferredContact?: string | null;
  preferredTime?: string | null;
}

/** The exact Pandora body, from the lead row — a pure function, pinned by test. */
export function buildMintInput(lead: LeadView, extras: MintExtras = {}): PartyLeadInput {
  return {
    location: CENTRE_TO_PANDORA_KEY[lead.centre],
    firstName: lead.guest.first,
    lastName: lead.guest.last,
    email: lead.guest.email ?? undefined,
    phone: lead.guest.phone ?? undefined,
    eventType: pandoraEventTypeFor(lead.type, lead.kids),
    eventDate: lead.eventDate,
    eventTime: lead.eventTime ?? undefined,
    estimatedGuests: String(lead.guests),
    agent: extras.agent?.trim() || FIRST_AVAILABLE,
    ...(extras.specialRequests
      ? { specialRequests: extras.specialRequests }
      : lead.notes
        ? { specialRequests: lead.notes }
        : {}),
    ...(extras.packageType ? { packageType: extras.packageType } : {}),
    ...(extras.preferredContact ? { preferredContact: extras.preferredContact } : {}),
    ...(extras.preferredTime ? { preferredTime: extras.preferredTime } : {}),
  };
}

export type MintOutcome =
  | {
      status: "minted";
      projectId: string;
      projectNumber: string;
      personId: string | null;
      assignedAgent: { userId?: string; name?: string } | null;
    }
  | { status: "none"; error: string }
  | { status: "failed"; error: string; httpStatus: number };

export function mintOutcomeView(o: MintOutcome): MintOutcomeView {
  if (o.status === "minted") {
    return {
      status: "minted",
      error: null,
      projectId: o.projectId,
      projectNumber: o.projectNumber,
    };
  }
  return { status: o.status, error: o.error, projectId: null, projectNumber: null };
}

export interface MintDeps {
  submit: (input: PartyLeadInput, opts: { signal: AbortSignal }) => Promise<PartyLeadResult>;
  timeoutMs: number;
}

export const defaultMintDeps: MintDeps = { submit: submitPartyLead, timeoutMs: MINT_TIMEOUT_MS };

/** Call Pandora (or refuse to, per (d)). No Neon here — see `mintLead`. */
export async function mintProject(
  lead: LeadView,
  extras: MintExtras = {},
  deps: MintDeps = defaultMintDeps,
): Promise<MintOutcome> {
  const blocker = mintBlocker(lead);
  if (blocker) return { status: "none", error: blocker };
  const res = await deps.submit(buildMintInput(lead, extras), {
    signal: AbortSignal.timeout(deps.timeoutMs),
  });
  if (!res.ok) return { status: "failed", error: res.error, httpStatus: res.status };
  return {
    status: "minted",
    projectId: res.projectID,
    projectNumber: res.projectNumber,
    personId: res.personID ?? null,
    assignedAgent: res.assignedAgent,
  };
}

export interface MintLeadDeps extends MintDeps {
  jobs: Pick<JobStore, "enqueue">;
  now: () => Date;
}

export function defaultMintLeadDeps(): MintLeadDeps {
  return { ...defaultMintDeps, jobs: neonJobStore, now: () => new Date() };
}

export interface MintLeadResult {
  outcome: MintOutcome;
  /** The lead after the outcome was written. */
  lead: LeadView;
}

/**
 * Mint and RECORD: the outcome lands on the lead row (and an activity), and a
 * failure enqueues the retry job with a per-lead idempotency key so a burst of
 * failures is one job, not a storm.
 */
export async function mintLead(
  lead: LeadView,
  extras: MintExtras = {},
  deps: MintLeadDeps = defaultMintLeadDeps(),
  actorEmail: string | null = null,
): Promise<MintLeadResult> {
  const outcome = await mintProject(lead, extras, deps);
  const now = deps.now();

  if (outcome.status === "minted") {
    const after = await updateLeadFields(lead.id, {
      bmiProjectId: outcome.projectId,
      bmiProjectNumber: outcome.projectNumber,
      bmiPersonId: outcome.personId,
      bmiSyncedAt: now,
      mintStatus: "minted",
      mintError: null,
      mintAttempts: lead.mintAttempts + 1,
    });
    await recordActivity({
      leadId: lead.id,
      contactId: lead.contactId,
      actorEmail,
      kind: "bmi",
      occurredAt: now,
      body:
        `BMI project ${outcome.projectNumber} created · state New Lead` +
        (outcome.assignedAgent?.name ? ` · responsible in BMI: ${outcome.assignedAgent.name}` : ""),
      externalKind: "pandora-party-lead",
      externalRef: outcome.projectId,
      meta: {
        projectId: outcome.projectId,
        projectNumber: outcome.projectNumber,
        agentSent: extras.agent?.trim() || FIRST_AVAILABLE,
        assignedAgent: outcome.assignedAgent,
      },
    });
    return { outcome, lead: after ?? lead };
  }

  if (outcome.status === "none") {
    await updateLeadFields(lead.id, { mintStatus: "none", mintError: outcome.error });
    const after = await getLead(lead.id);
    return { outcome, lead: after ?? lead };
  }

  await bumpMintAttempt(lead.id, { mintStatus: "failed", mintError: outcome.error });
  await recordActivity({
    leadId: lead.id,
    contactId: lead.contactId,
    actorEmail,
    kind: "system",
    occurredAt: now,
    body: `BMI project not created — ${outcome.error} (queued for retry)`,
    meta: { httpStatus: outcome.httpStatus, error: outcome.error },
  });
  try {
    await deps.jobs.enqueue({
      kind: MINT_JOB_KIND,
      idempotencyKey: `${MINT_JOB_KIND}:${lead.id}:mint`,
      payload: { leadId: lead.id, task: "mint" },
      createdBy: actorEmail ?? "createLead",
    });
  } catch (err) {
    console.error("[crm] could not enqueue mint retry", {
      lead_id: lead.id,
      actor_email: actorEmail,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const after = await getLead(lead.id);
  return { outcome, lead: after ?? lead };
}
