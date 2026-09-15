/**
 * `createLead` — the ONE way a lead enters the CRM (web form, a phone call
 * logged by staff, a walk-in, a referral; C8's cold-list conversions later).
 *
 * ORDER IS THE CONTRACT (R2 — persist guest input BEFORE any external call):
 *
 *   1. normalise the phone (`canonicalizePhone`), upsert account + contact
 *   2. INSERT `crm_leads` with `capture_payload` (the raw submission, always),
 *      `mint_status` 'pending' — or 'none' with `needs_email_or_time` when
 *      Pandora could not accept it, or 'none' for a prospect — COMMITTED
 *   3. activity "Lead captured …"
 *   4. `suggestFor` — the assignment rules (B2's engine)
 *   5. `mintLead` → Pandora, `agent` = the pick's Office name or "First Available"
 *   6. `assignLead(reason:'rule')` for EVERY decision the engine resolved —
 *      including the planner the guest asked for, when the rules honoured
 *      that request (B7's `weighGuestRequest` decides WHO; step 6 is WHEN)
 *   7. notifications — never fatal
 *
 * ASSIGN AT CAPTURE, AT ALL HOURS (owner, 2026-09-13 14:50: "let's get rid of
 * the hour sweep rule just capture right away"). Step 6 applies whatever the
 * engine named, not just the decisions taken for a business reason: a
 * ≥ 100-guest enquiry is parked for the Marketing Director, a kids' birthday
 * is routed to Guest Services, AND the balancing rule's pick ("lowest Oct
 * volume") is handed over there and then, with `crm_assignments.reason 'rule'`
 * and the same trace the sweep would have stored. Nothing waits for an hour
 * and nothing waits for 9 AM — R5 already answers "nobody is on shift now" by
 * narrowing to whoever works the next shift, and a lead sitting unassigned
 * overnight is strictly worse than one waiting for the person who opens up.
 * `rules/service/sweep.ts` is now only the net under this step.
 *
 * ASSIGN BEFORE NOTIFY, deliberately. The Teams fan-out has to know whether
 * the lead ended up with an assignee: an ordinary one gets a single card in
 * its planner's chat, and only a lead nobody owns — parked by a hold rule or
 * left unresolved — goes to "Sales Leads - Assignment Pending". Reading
 * `lead.rep` after step 6 is the one place that fact is true.
 *
 * A form resubmitted within 15 minutes for the same guest / centre / date
 * after a failed mint re-uses the row instead of creating a second one; a
 * resubmit after a SUCCESSFUL mint is returned as-is (no second project, no
 * second text to the guest).
 */

import { canonicalizePhone } from "@/lib/participant-contact";
import { recordActivity } from "~/features/crm/activities";
import { crmAutoAssignEnabled } from "../../core/flags";
import type { CentreCode, CrmRep, EventType, LeadSource } from "../../core/types";
import { LEAD_SOURCE_LABEL, type LeadView } from "../contracts";
import { upsertAccountByName } from "../data/accounts-db";
import { emailKeyOf, upsertContact } from "../data/contacts-db";
import { findRecentDuplicateLead, getLead, insertLead } from "../data/leads-db";
import { bmiUsernameFor } from "~/features/crm/reps/bmi-user-id";
import { centreByCode } from "../../core/centres";
import { assignLead, type AssignResult } from "./assign";
import { NEEDS_EMAIL_OR_TIME, mintLead, pandoraEventTypeFor, type MintOutcome } from "./mint";
import { notifyAlreadySent, notifyNewLead, summarizeNotify, type NotifyOutcome } from "./notify";
import { listReps } from "~/features/crm/reps";
import { NO_SUGGESTION, suggestFor, type SuggestResult } from "./suggest";
import { plannerOptions } from "../planners";

export interface CreateLeadInput {
  centre: CentreCode;
  firstName: string;
  lastName: string;
  /** Any format; canonicalised to E.164 here. */
  phone: string | null;
  email: string | null;
  company?: string | null;
  eventDate: string;
  eventTime: string | null;
  guests: number;
  type: EventType;
  kids: boolean;
  notes?: string | null;
  prefers?: "text" | "call" | "email" | null;
  preferredContactMethod?: "phone" | "text" | "email";
  bestTimeToCall?: string;
  activityInterest?: string[];
  packageType?: string;
  /** Overrides `notes` as Pandora's specialRequests (the web form's rich blob). */
  specialRequests?: string | null;
  eventTypeLabel?: string;
  /**
   * B7 — the `crm_reps.slug` the guest picked under "Who would you like to
   * work with?". Resolved against the roster here (never trusted as an id) and
   * stored on `crm_leads.requested_rep_id`; ignored for a children's party,
   * which Pandora force-routes to Guest Services whatever `agent` we send.
   */
  requestedPlannerSlug?: string | null;
  /** The raw submission, stored verbatim. */
  capturePayload: Record<string, unknown>;
  /** The member of staff who logged it; null for the web form. */
  createdBy: string | null;
}

export interface CreateLeadOptions {
  source: LeadSource;
  /** actor_email for the activity / assignment rows; "web" for the form. */
  actorEmail?: string | null;
  /** Cold / historical rows before conversion — no mint, no notifications. */
  isProspect?: boolean;
  /** Test / bulk-import switches; all default true. */
  mint?: boolean;
  notify?: boolean;
  autoAssign?: boolean;
}

export interface CreateLeadResult {
  lead: LeadView;
  /** false = an existing recent row was re-used. */
  created: boolean;
  mint: MintOutcome;
  notify: NotifyOutcome | null;
  suggestion: SuggestResult;
  assignment: AssignResult | null;
}

export interface CreateLeadDeps {
  upsertAccount: typeof upsertAccountByName;
  upsertContact: typeof upsertContact;
  insertLead: typeof insertLead;
  getLead: typeof getLead;
  findDuplicate: typeof findRecentDuplicateLead;
  recordActivity: typeof recordActivity;
  suggest: typeof suggestFor;
  listReps: typeof listReps;
  mintLead: typeof mintLead;
  notify: typeof notifyNewLead;
  /** The no-op fan-out for a resubmit we have already answered once. */
  notifyAlreadySent: typeof notifyAlreadySent;
  assign: typeof assignLead;
  /** The `CRM_AUTO_ASSIGN` kill switch (R4, absent = ON); injected by its test. */
  autoAssignEnabled: typeof crmAutoAssignEnabled;
  now: () => Date;
}

export function defaultCreateLeadDeps(): CreateLeadDeps {
  return {
    upsertAccount: upsertAccountByName,
    upsertContact,
    insertLead,
    getLead,
    findDuplicate: findRecentDuplicateLead,
    recordActivity,
    suggest: suggestFor,
    listReps,
    mintLead,
    notify: notifyNewLead,
    notifyAlreadySent,
    assign: assignLead,
    autoAssignEnabled: crmAutoAssignEnabled,
    now: () => new Date(),
  };
}

export const PROSPECT_SOURCES: readonly LeadSource[] = ["cold", "historical"];

/**
 * The guest's pick → the roster row, or null. The slug is never trusted as an
 * id: it must belong to a planner the form would actually have offered for
 * that centre (`plannerOptions` is the one definition of that), so a stale
 * bookmark, a planner who has left, a Naples enquiry naming a Fort Myers
 * planner, and a forged body all resolve to "First available".
 *
 * A children's party resolves to null whatever was sent: Pandora force-routes
 * `"Child Birthday"` to Guest Services regardless of `agent` (brief §1.6), so
 * storing a request we can never honour would only mislead the planner
 * reading the deal.
 */
export function requestedRepFrom(
  reps: readonly CrmRep[],
  slug: string | null | undefined,
  centre: CentreCode,
  kidsBirthday: boolean,
): CrmRep | null {
  if (!slug || kidsBirthday) return null;
  const offered = plannerOptions(reps).some((p) => p.slug === slug && p.centres.includes(centre));
  if (!offered) return null;
  return reps.find((r) => r.slug === slug) ?? null;
}

/** The capture line (crm-data.js:67-82 wording). */
export function captureLine(source: LeadSource, actor: string | null): string {
  const who = actor ?? "staff";
  switch (source) {
    case "web":
      return "Lead captured from the web form";
    case "phone":
      return `Logged by ${who} from an inbound call`;
    case "walkin":
      return `Logged by ${who} from a walk-in`;
    case "referral":
      return `Referral entered by ${who}`;
    default:
      return `Lead created from ${LEAD_SOURCE_LABEL[source].toLowerCase()} by ${who}`;
  }
}

export async function createLead(
  input: CreateLeadInput,
  opts: CreateLeadOptions,
  deps: CreateLeadDeps = defaultCreateLeadDeps(),
): Promise<CreateLeadResult> {
  const actor = opts.actorEmail ?? input.createdBy ?? (opts.source === "web" ? "web" : null);
  const isProspect = opts.isProspect ?? PROSPECT_SOURCES.includes(opts.source);
  const phoneE164 = canonicalizePhone(input.phone);
  const email = emailKeyOf(input.email);

  // A resubmit after a failed (or slow) Pandora call must not double the row.
  const dup = await deps.findDuplicate({
    phoneE164,
    emailKey: email,
    centre: input.centre,
    eventDate: input.eventDate,
  });
  if (dup && dup.mintStatus === "minted") {
    // Nothing is sent twice — but the answer must be indistinguishable from
    // the first one, planner included, or the guest's second success screen
    // names a different person than their first (and their text).
    return {
      lead: dup,
      created: false,
      mint: {
        status: "minted",
        projectId: dup.bmi.projectId ?? "",
        projectNumber: dup.bmi.projectNumber ?? "",
        personId: dup.bmi.personId,
        assignedAgent: null,
      },
      notify: await deps.notifyAlreadySent({ lead: dup, projectId: dup.bmi.projectId }),
      suggestion: NO_SUGGESTION,
      assignment: null,
    };
  }

  let lead: LeadView;
  let created = false;
  if (dup) {
    lead = dup;
  } else {
    // 1. account + contact
    const account = input.company?.trim()
      ? await deps.upsertAccount({
          name: input.company.trim(),
          kind: "business",
          centre: input.centre,
        })
      : null;
    const contact = await deps.upsertContact({
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      phoneE164,
      email: input.email ? input.email.trim() : null,
      accountId: account?.id ?? null,
      prefers: input.prefers ?? null,
    });

    // 2. the lead row — Neon first, always
    const blocker = isProspect
      ? "prospect"
      : !contact.email || !input.eventTime
        ? NEEDS_EMAIL_OR_TIME
        : null;
    // B7: the planner the guest asked for, resolved against the live roster.
    // Only read the roster when they actually picked someone.
    const requestedRep = input.requestedPlannerSlug
      ? requestedRepFrom(
          await deps.listReps(),
          input.requestedPlannerSlug,
          input.centre,
          pandoraEventTypeFor(input.type, input.kids) === "Child Birthday",
        )
      : null;

    const id = await deps.insertLead({
      contactId: contact.id,
      accountId: account?.id ?? null,
      centre: input.centre,
      eventDate: input.eventDate,
      eventTime: input.eventTime,
      guests: input.guests,
      type: input.type,
      source: opts.source,
      isProspect,
      kids: input.kids,
      notes: input.notes ?? null,
      mintStatus: blocker ? "none" : "pending",
      mintError: blocker && blocker !== "prospect" ? blocker : null,
      capturePayload: input.capturePayload,
      createdBy: input.createdBy,
      requestedRepId: requestedRep?.id ?? null,
    });
    const fresh = await deps.getLead(id);
    if (!fresh) throw new Error(`crm_leads: inserted ${id} but could not read it back`);
    lead = fresh;
    created = true;

    // 3. the capture line
    await deps.recordActivity({
      leadId: lead.id,
      contactId: lead.contactId,
      actorEmail: actor,
      kind: "system",
      occurredAt: deps.now(),
      body: `${captureLine(opts.source, input.createdBy)} · ${lead.centre}`,
      meta: { source: opts.source, isProspect },
    });
  }

  // 4. the engine
  const suggestion = await deps.suggest(lead, { now: deps.now() });
  // One kill switch, read once and honoured everywhere below: with
  // `CRM_AUTO_ASSIGN="false"` the rules drive nothing — not our own assignment
  // and not Pandora's `agent` either, which would otherwise put the lead on a
  // planner in BMI and tell the guest their name while our queue still called
  // it unassigned. Pandora falls back to its own round robin.
  const autoAssignOn = opts.autoAssign !== false && deps.autoAssignEnabled();

  // 5. Pandora
  let mint: MintOutcome;
  if (isProspect) {
    mint = { status: "none", error: "prospect" };
  } else if (opts.mint === false) {
    mint = { status: "none", error: "mint disabled" };
  } else {
    const r = await deps.mintLead(
      lead,
      {
        /**
         * The name PANDORA will recognise ON THIS TENANT. Naples calls the
         * same people by their first name alone ("Stephanie", not "Stephanie
         * Wegman") and the call centre "CallCenter", and Pandora matches with
         * `name.includes(agent)` — so the Fort Myers name found nobody there
         * and the mint died with "Failed to assign an agent for this lead."
         */
        agent:
          (autoAssignOn && suggestion.suggestion
            ? bmiUsernameFor(suggestion.suggestion.rep, centreByCode(lead.centre).clientKey)
            : null) ?? null,
        specialRequests: input.specialRequests ?? null,
        packageType: input.packageType ?? null,
        preferredContact: input.preferredContactMethod ?? null,
        preferredTime: input.bestTimeToCall ?? null,
      },
      undefined,
      actor,
    );
    mint = r.outcome;
    lead = r.lead;
  }

  // 6. the engine's pick — every decision it resolved, applied now
  let assignment: AssignResult | null = null;
  if (suggestion.suggestion && autoAssignOn && !lead.rep) {
    try {
      assignment = await deps.assign({
        leadId: lead.id,
        repId: suggestion.suggestion.rep.id,
        actor: actor ?? "rules",
        reason: "rule",
        ruleId: suggestion.suggestion.ruleId,
        trace: suggestion.trace,
        // Step 7 does the guest's welcome, with the form's own contact
        // preference and the planner's card beside it.
        // Step 7 does BOTH the guest's welcome and the planner's card, with
        // the form's own contact preference and the capture's context. Letting
        // the hand-off post its own card as well put two of them in the same
        // chat (owner, 2026-09-14: "Duplication in call center teams chat").
        introduceGuest: false,
        tellOwner: false,
      });
      lead = assignment.lead;
    } catch (err) {
      // The capture stands; the safety-net sweep picks the lead up next run.
      console.error("[crm] assign at capture failed", {
        lead_id: lead.id,
        actor_email: actor,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 7. notifications — never fatal
  let notify: NotifyOutcome | null = null;
  if (!isProspect && opts.notify !== false) {
    try {
      notify = await deps.notify({
        lead,
        mint,
        source: opts.source,
        assigned: lead.rep !== null,
        preferredContactMethod: input.preferredContactMethod,
        bestTimeToCall: input.bestTimeToCall,
        activityInterest: input.activityInterest,
        eventTypeLabel: input.eventTypeLabel,
      });
      await deps.recordActivity({
        leadId: lead.id,
        contactId: lead.contactId,
        actorEmail: actor,
        kind: "system",
        occurredAt: deps.now(),
        body: summarizeNotify(notify),
        meta: notify as unknown as Record<string, unknown>,
      });
    } catch (err) {
      // `notifyNewLead` never throws by design; this guards a replaced dep.
      console.error("[crm] notifications failed after capture", {
        lead_id: lead.id,
        actor_email: actor,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { lead, created, mint, notify, suggestion, assignment };
}
