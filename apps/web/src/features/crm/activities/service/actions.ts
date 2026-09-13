/**
 * THE THREE THINGS A REP LOGS BY HAND on a deal — Note, Snooze and a call
 * disposition (crm-shared.js:276-279 `note` / `save-note` / `snooze` /
 * `snooze-to`, and :256 `dispo`).
 *
 * Each is Neon-only except the call, which may advance the lead's status — and
 * a status change is never written here: it goes through `transition()`, the
 * one status writer, so the mapped BMI state is written by the same rail a
 * board drag uses (R5, one writer per entity).
 *
 * A NOTE IS NEVER WRITTEN TO BMI (R6). The sheet says so ("Private to the
 * sales team. Never written to BMI.") and this module keeps the promise: it
 * writes `crm_activities` and nothing else. BMI's own notes are B6's Notes
 * tab, through `appendProjectPrivateNote` / `updateProjectPublicNotes`.
 */

import { getLead, noteOutboundTouch, updateLeadFields } from "~/features/crm/leads";
import type { LeadView } from "~/features/crm/leads/contracts";
import { transition } from "~/features/crm/statuses/service/transition";
import { ET, etOffsetFor, shiftYmd, todayEasternYmd } from "../../core/dates";
import type { CrmActivity } from "../../core/types";
import { SNOOZE_HOUR_ET, type CallOutcome, type SnoozePresetId } from "../contracts";
import { recordActivity } from "./record";
import { getActivity } from "./timeline";
import { countTouchesToday } from "./touches";

const ET_WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short" });
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD read in ET. */
export function etWeekday(ymd: string): number {
  const label = ET_WEEKDAY.format(new Date(`${ymd}T12:00:00${etOffsetFor(ymd)}`));
  const ix = WEEKDAYS.indexOf(label);
  return ix < 0 ? 0 : ix;
}

/** The next Monday STRICTLY after `ymd` (so "Monday 9 AM" on a Monday means next week). */
export function nextMondayYmd(ymd: string): string {
  const dow = etWeekday(ymd);
  const delta = (8 - dow) % 7 || 7;
  return shiftYmd(ymd, delta);
}

/**
 * When a snooze preset lands: 9 AM ET on the chosen day, as a UTC instant.
 * The prototype hard-codes "Monday" as +2 days because its clock is frozen on
 * a Saturday; a real Monday is computed, so the button cannot snooze to a
 * Wednesday.
 */
export function snoozeDueIso(preset: SnoozePresetId, now: Date = new Date()): string {
  const today = todayEasternYmd(now);
  const ymd =
    preset === "tomorrow"
      ? shiftYmd(today, 1)
      : preset === "three-days"
        ? shiftYmd(today, 3)
        : preset === "next-week"
          ? shiftYmd(today, 7)
          : nextMondayYmd(today);
  const hh = String(SNOOZE_HOUR_ET).padStart(2, "0");
  return new Date(`${ymd}T${hh}:00:00${etOffsetFor(ymd)}`).toISOString();
}

export interface ActionDeps {
  recordActivity: typeof recordActivity;
  getActivity: typeof getActivity;
  getLead: typeof getLead;
  updateLeadFields: typeof updateLeadFields;
  noteOutboundTouch: typeof noteOutboundTouch;
  countTouchesToday: typeof countTouchesToday;
  transition: typeof transition;
  now: () => Date;
}

export function defaultActionDeps(): ActionDeps {
  return {
    recordActivity,
    getActivity,
    getLead,
    updateLeadFields,
    noteOutboundTouch,
    countTouchesToday,
    transition,
    now: () => new Date(),
  };
}

export interface ActionResult {
  activity: CrmActivity | null;
  lead: LeadView;
  countedAsTouch: boolean;
}

/** "Save note" — `crm_activities` only, never BMI. */
export async function addNote(
  input: { lead: LeadView; body: string; actor: string },
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult> {
  const now = deps.now();
  const id = await deps.recordActivity({
    leadId: input.lead.id,
    contactId: input.lead.contactId,
    repId: input.lead.rep,
    actorEmail: input.actor,
    kind: "note",
    occurredAt: now,
    body: input.body,
  });
  return {
    activity: id ? await deps.getActivity(id) : null,
    lead: (await deps.getLead(input.lead.id)) ?? input.lead,
    countedAsTouch: false,
  };
}

/**
 * "Snooze follow-up" — moves `next_action_due` and says so on the timeline.
 * The prototype silently moved the due time; a follow-up that slips is exactly
 * the thing a director asks about later, so it leaves a line.
 */
export async function snoozeLead(
  input: { lead: LeadView; preset: SnoozePresetId; label: string; actor: string },
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult> {
  const now = deps.now();
  const due = snoozeDueIso(input.preset, now);
  await deps.updateLeadFields(input.lead.id, {
    nextActionKind: input.lead.nextAction?.kind ?? "call",
    nextActionDue: due,
    nextActionLabel: input.lead.nextAction?.label ?? "Follow up",
  });
  const id = await deps.recordActivity({
    leadId: input.lead.id,
    contactId: input.lead.contactId,
    repId: input.lead.rep,
    actorEmail: input.actor,
    kind: "system",
    occurredAt: now,
    body: `Follow-up snoozed to ${input.label} by ${input.actor}`,
    meta: { snoozedTo: due, preset: input.preset },
  });
  return {
    activity: id ? await deps.getActivity(id) : null,
    lead: (await deps.getLead(input.lead.id)) ?? input.lead,
    countedAsTouch: false,
  };
}

/**
 * A call logged by hand (`dispo`, crm-shared.js:256). Until C3 journals 3CX,
 * this is how a call reaches the timeline — and it is honest about being
 * manual: `external_kind` stays null, so C3's reconcile can never mistake it
 * for a 3CX row and dedupe against it.
 *
 * Three follow-on effects, each the prototype's and each real here:
 *   • the first outbound touch by the ASSIGNEE stamps `first_touch_at`;
 *   • an "Assigned" lead becomes "Contacted" — through `transition()`, so the
 *     mapped BMI state is written by the one writer;
 *   • "Reached" clears the next action (the rep decides the next step).
 */
export async function logCall(
  input: {
    lead: LeadView;
    outcome: CallOutcome;
    note?: string | null;
    durationSeconds?: number | null;
    actor: string;
    /** The rep the call is credited to — the assignee by default. */
    repId?: string | null;
  },
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult> {
  const now = deps.now();
  const repId = input.repId ?? input.lead.rep;
  // The rule (crm-shared.js:418): a touch counts once per lead per channel per
  // ET day. `countTouchesToday` already collapses the day to at most one per
  // channel, so "this call is a NEW touch" is exactly "no call counted today".
  // The activity is recorded either way — only the SCORE is deduped.
  const before = await deps.countTouchesToday(input.lead.id, now);
  const counted = before.call === 0;

  const id = await deps.recordActivity({
    leadId: input.lead.id,
    contactId: input.lead.contactId,
    repId,
    actorEmail: input.actor,
    kind: "call",
    direction: "out",
    occurredAt: now,
    durationSeconds: input.durationSeconds ?? null,
    outcome: input.outcome,
    body: input.note ?? null,
    meta: { source: "manual" },
  });

  await deps.noteOutboundTouch(
    { kind: "call", direction: "out", repId, occurredAt: now },
    { id: input.lead.id, rep: input.lead.rep },
  );

  if (input.outcome === "Reached") {
    await deps.updateLeadFields(input.lead.id, {
      nextActionKind: null,
      nextActionDue: null,
      nextActionLabel: null,
    });
  }

  let lead = (await deps.getLead(input.lead.id)) ?? input.lead;
  if (lead.status === "assigned") {
    // A call is a contact. The status writer handles BMI (mapped or not).
    const moved = await deps.transition({
      lead,
      toStatusId: "contacted",
      actor: input.actor,
      note: `after a call · ${input.outcome}`,
    });
    lead = moved.lead;
  }

  return {
    activity: id ? await deps.getActivity(id) : null,
    lead,
    countedAsTouch: counted,
  };
}
