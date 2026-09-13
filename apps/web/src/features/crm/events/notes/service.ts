/**
 * BMI NOTES — the CRM's two write rails and nothing else (R6).
 *
 *   PUBLIC   `updateProjectPublicNotes` — REPLACE-only, and only after the
 *            grammar pass the contract-send path already runs
 *            (`cleanupNotesGrammar`, `apps/web/lib/notes-grammar.ts`, used by
 *            `app/api/cron/group-quote-dispatch/route.ts:1030-1040`). The
 *            guest reads this on the contract page, so the CRM shows the
 *            cleaned text BEFORE it is written (`preview: true` writes nothing).
 *   PRIVATE  `appendProjectPrivateNote` — merge-append inside the
 *            `── FastTrax Web ──` section, which is the only section the CRM
 *            may touch. NEVER `PUT projectLog`: that whole-entity write belongs
 *            to `syncBmiNotes`, whose `----- Portal Staff -----` slice the CRM
 *            only ever reads.
 *
 * ORDER (R2): the rep's text lands in `crm_activities` BEFORE the Office call,
 * every time. If Office is down, the note is still on the deal's timeline and
 * the rep is told the BMI half failed — never "saved" over a lost write.
 *
 * VERIFY (R5): a 200 from Pandora or Office is not proof. The public save
 * re-reads the project and compares; `appendProjectPrivateNote` does its own
 * re-read and returns false when it could not confirm.
 *
 * KILL SWITCH (R4): `bmiWritesAllowedFor(clientKey, crm_settings.bmi_writes)`
 * — env AND the director's toggle, and a missing row means ON.
 */

import {
  appendProjectPrivateNote,
  hasWaiverRequiredActivities,
  noteTimestamp,
  updateProjectPublicNotes,
} from "@/lib/bmi-office-actions";
import { getGfQuoteByReservationId, type GroupFunctionQuote } from "@/lib/group-function-db";
import { cleanupNotesGrammar } from "@/lib/notes-grammar";
import { notifyWaiverReminder } from "@/lib/group-function-notify";
import { waiverLinksForReservation } from "@/lib/waiver-link-send";
import { aiGatewayKey } from "~/lib/api/ai-gateway";
import { getEventMetadata, saveManualFoodOut } from "~/features/daily-events/service";
import { listLeadTimeline, recordActivity } from "~/features/crm/activities";
import { officeProject } from "~/features/crm/bmi";
import { centreByCode } from "../../core/centres";
import { writeAudit } from "../../core/data/audit-db";
import { getSettingValue } from "../../core/data/settings-db";
import { bmiWritesAllowedFor } from "../../core/flags";
import type { CentreCode } from "../../core/types";
import {
  EMPTY_FOOD_OUT,
  type CrmNoteView,
  type EventFoodOut,
  type PrivateNoteSection,
} from "../contracts";
import { foodOutFromMemo, parsePrivateMemo } from "./sections";

/** The CRM's stable session tag for note reads — never a clock, never a UUID. */
export const CRM_NOTES_SESSION_TAG = "crm-notes";

export class BmiWritesPausedError extends Error {
  constructor(clientKey: string) {
    super(`BMI writes are paused for ${clientKey}`);
    this.name = "BmiWritesPausedError";
  }
}

/** The two log rows the CRM cares about on an Office project. */
interface ProjectLogRow {
  id?: unknown;
  public?: unknown;
  kind?: unknown;
  memo?: unknown;
}

interface ProjectWithLogs {
  id?: unknown;
  date?: unknown;
  when?: unknown;
  logs?: ProjectLogRow[];
}

function memoOf(logs: ProjectLogRow[] | undefined, isPublic: boolean): string {
  const row = (logs ?? []).find((l) => Boolean(l.public) === isPublic);
  return typeof row?.memo === "string" ? row.memo : "";
}

export interface NotesDeps {
  readProject: (clientKey: string, projectId: string) => Promise<ProjectWithLogs>;
  updatePublic: typeof updateProjectPublicNotes;
  appendPrivate: typeof appendProjectPrivateNote;
  cleanup: typeof cleanupNotesGrammar;
  cleanupAvailable: () => boolean;
  saveFoodOut: typeof saveManualFoodOut;
  getEventMetadata: typeof getEventMetadata;
  getQuote: (projectId: string) => Promise<GroupFunctionQuote | null>;
  waiverLinks: typeof waiverLinksForReservation;
  notifyWaiver: typeof notifyWaiverReminder;
  listTimeline: typeof listLeadTimeline;
  recordActivity: typeof recordActivity;
  writeAudit: typeof writeAudit;
  getSettingValue: typeof getSettingValue;
  now: () => Date;
}

export function defaultNotesDeps(): NotesDeps {
  return {
    readProject: (clientKey, projectId) =>
      officeProject<ProjectWithLogs>(clientKey, projectId, CRM_NOTES_SESSION_TAG),
    updatePublic: updateProjectPublicNotes,
    appendPrivate: appendProjectPrivateNote,
    cleanup: cleanupNotesGrammar,
    cleanupAvailable: () => aiGatewayKey() !== "",
    saveFoodOut: saveManualFoodOut,
    getEventMetadata,
    getQuote: getGfQuoteByReservationId,
    waiverLinks: waiverLinksForReservation,
    notifyWaiver: notifyWaiverReminder,
    listTimeline: listLeadTimeline,
    recordActivity,
    writeAudit,
    getSettingValue,
    now: () => new Date(),
  };
}

async function assertWritesAllowed(clientKey: string, deps: NotesDeps): Promise<void> {
  const setting = await deps.getSettingValue("bmi_writes");
  if (!bmiWritesAllowedFor(clientKey, setting)) throw new BmiWritesPausedError(clientKey);
}

export interface NotesTarget {
  centre: CentreCode;
  projectId: string;
  /** The CRM lead, when the project is joined to one. */
  leadId: string | null;
  /** The event's ET calendar day — `event_metadata` is keyed by it. */
  date?: string | null;
}

export interface NotesBody {
  projectId: string;
  centre: CentreCode;
  publicNotes: string;
  privateMemo: string;
  sections: PrivateNoteSection[];
  foodOut: EventFoodOut;
  crmNotes: CrmNoteView[];
  writesEnabled: boolean;
}

/** Everything the Notes tab renders, in one read. */
export async function readNotes(
  target: NotesTarget,
  deps: NotesDeps = defaultNotesDeps(),
): Promise<NotesBody> {
  const centre = centreByCode(target.centre);
  const [project, setting, timeline, metadata] = await Promise.all([
    deps.readProject(centre.clientKey, target.projectId),
    deps.getSettingValue("bmi_writes"),
    target.leadId
      ? deps.listTimeline(target.leadId, { limit: 100 })
      : Promise.resolve({ activities: [], nextCursor: null }),
    target.date
      ? deps.getEventMetadata(target.projectId, centre.locationId, target.date).catch(() => null)
      : Promise.resolve(null),
  ]);

  const privateMemo = memoOf(project.logs, false);
  // BMI's own Portal Staff line is what the desk and the kitchen board read;
  // `event_metadata` is where the time CAME from. Show BMI's value with our
  // provenance, so a hand-edit made in Office is never overwritten on screen
  // by a stale row of ours.
  const memoTime = foodOutFromMemo(privateMemo);
  const foodOut: EventFoodOut = metadata
    ? {
        time: memoTime ?? metadata.foodOutTime,
        source: metadata.foodOutSource,
        confidence: metadata.foodOutConfidence,
        reasoning: metadata.foodOutReasoning,
        updatedAt: metadata.updatedAt,
      }
    : { ...EMPTY_FOOD_OUT, time: memoTime };

  return {
    projectId: target.projectId,
    centre: target.centre,
    publicNotes: memoOf(project.logs, true),
    privateMemo,
    sections: parsePrivateMemo(privateMemo),
    foodOut,
    crmNotes: timeline.activities
      .filter((a) => a.kind === "note")
      .map((a) => ({
        id: a.id,
        actorEmail: a.actorEmail,
        body: a.body ?? "",
        occurredAt: a.occurredAt,
      })),
    writesEnabled: bmiWritesAllowedFor(centre.clientKey, setting),
  };
}

export interface PreviewResult {
  original: string;
  cleaned: string;
  changed: boolean;
  available: boolean;
}

/**
 * The grammar pass, run and SHOWN — never written. `cleanupNotesGrammar`
 * returns the input untouched when the gateway key is missing or the call
 * fails, so `available` is what tells the rep whether a preview meant anything.
 */
export async function previewPublicNotes(
  notes: string,
  deps: NotesDeps = defaultNotesDeps(),
): Promise<PreviewResult> {
  const available = deps.cleanupAvailable();
  const cleaned = available && notes.trim() ? await deps.cleanup(notes) : notes;
  return { original: notes, cleaned, changed: cleaned !== notes, available };
}

export interface SavePublicInput extends NotesTarget {
  notes: string;
  clean: boolean;
  actor: string;
}

export interface SavePublicResult {
  publicNotes: string;
  cleaned: boolean;
  verified: boolean;
}

export async function savePublicNotes(
  input: SavePublicInput,
  deps: NotesDeps = defaultNotesDeps(),
): Promise<SavePublicResult> {
  const centre = centreByCode(input.centre);
  await assertWritesAllowed(centre.clientKey, deps);

  const preview = input.clean
    ? await previewPublicNotes(input.notes, deps)
    : { original: input.notes, cleaned: input.notes, changed: false, available: false };
  const text = preview.cleaned;

  const before = memoOf((await deps.readProject(centre.clientKey, input.projectId)).logs, true);

  // Neon FIRST: the text the guest will see is on the timeline before Office
  // is asked for anything (R2).
  await deps.recordActivity({
    leadId: input.leadId,
    actorEmail: input.actor,
    kind: "note",
    direction: "out",
    subject: "Public notes saved to BMI",
    body: text,
    meta: { target: "bmi_public", projectId: input.projectId, cleaned: preview.changed },
  });

  await deps.updatePublic({
    centerCode: centre.centerCode,
    projectId: input.projectId,
    notes: text,
  });

  // R5: never trust a 200 — Pandora can answer `{"success":true}` without the
  // write landing, and the Office fallback is a PUT we did not watch.
  const after = memoOf((await deps.readProject(centre.clientKey, input.projectId)).logs, true);
  const verified = after.trim() === text.trim();

  await deps.recordActivity({
    leadId: input.leadId,
    actorEmail: input.actor,
    kind: "bmi",
    outcome: verified ? "public_notes_synced" : "public_notes_unverified",
    subject: verified
      ? "Public notes updated in BMI · guest page updated"
      : "Public notes were sent to BMI but the re-read did not match",
    meta: { target: "bmi_public", projectId: input.projectId },
  });

  await deps.writeAudit({
    entity: "bmi_project",
    entityId: input.projectId,
    action: "public_notes",
    actorEmail: input.actor,
    before: { notes: before },
    after: { notes: text, verified },
  });

  return { publicNotes: text, cleaned: preview.changed, verified };
}

export interface AppendPrivateInput extends NotesTarget {
  note: string;
  actor: string;
}

export interface AppendPrivateResult {
  appended: boolean;
  privateMemo: string;
  sections: PrivateNoteSection[];
}

/** The rep's line, stamped and attributed, appended to the FastTrax Web section. */
export function privateNoteLine(note: string, actor: string, stamp: string): string {
  return `[${stamp}] ${note.trim()} — ${actor}`;
}

export async function appendPrivateNote(
  input: AppendPrivateInput,
  deps: NotesDeps = defaultNotesDeps(),
): Promise<AppendPrivateResult> {
  const centre = centreByCode(input.centre);
  await assertWritesAllowed(centre.clientKey, deps);

  const line = privateNoteLine(input.note, input.actor, noteTimestamp());

  // Neon FIRST (R2) — the note exists on the deal whatever Office answers.
  await deps.recordActivity({
    leadId: input.leadId,
    actorEmail: input.actor,
    kind: "note",
    direction: "out",
    subject: "Private note appended to BMI",
    body: input.note.trim(),
    meta: { target: "bmi_private", projectId: input.projectId },
  });

  const appended = await deps.appendPrivate({
    centerCode: centre.centerCode,
    projectId: input.projectId,
    note: line,
  });

  const privateMemo = memoOf(
    (await deps.readProject(centre.clientKey, input.projectId)).logs,
    false,
  );

  await deps.recordActivity({
    leadId: input.leadId,
    actorEmail: input.actor,
    kind: "bmi",
    outcome: appended ? "private_note_appended" : "private_note_failed",
    subject: appended
      ? "Private note appended in BMI"
      : "BMI would not take the private note — it is on this timeline only",
    meta: { target: "bmi_private", projectId: input.projectId },
  });

  return { appended, privateMemo, sections: parsePrivateMemo(privateMemo) };
}

export interface SaveFoodOutInput extends NotesTarget {
  /** The event's ET calendar day — `event_metadata` is keyed by it. */
  date: string;
  foodOutTime: string | null;
  actor: string;
}

/**
 * Food out is a `event_metadata` row plus a BMI sync: `saveManualFoodOut`
 * writes the row and then fires `syncBmiNotes`, which rewrites the
 * `----- Portal Staff -----` section — the one place the CRM is allowed to
 * change that section, and it does it through the existing rail rather than
 * touching the memo itself.
 */
export async function saveFoodOut(
  input: SaveFoodOutInput,
  deps: NotesDeps = defaultNotesDeps(),
): Promise<EventFoodOut> {
  const centre = centreByCode(input.centre);
  await assertWritesAllowed(centre.clientKey, deps);

  const saved = await deps.saveFoodOut({
    projectId: input.projectId,
    locationId: centre.locationId,
    date: input.date,
    foodOutTime: input.foodOutTime,
  });

  await deps.recordActivity({
    leadId: input.leadId,
    actorEmail: input.actor,
    kind: "bmi",
    outcome: "food_out_set",
    subject: input.foodOutTime
      ? `Food out ${input.foodOutTime} · synced to the kitchen board and BMI`
      : "Food out cleared",
    meta: { target: "food_out", projectId: input.projectId, date: input.date },
  });

  await deps.writeAudit({
    entity: "bmi_project",
    entityId: input.projectId,
    action: "food_out",
    actorEmail: input.actor,
    before: null,
    after: { foodOutTime: input.foodOutTime, date: input.date },
  });

  return {
    time: saved.foodOutTime,
    source: saved.foodOutSource,
    confidence: saved.foodOutConfidence,
    reasoning: saved.foodOutReasoning,
    updatedAt: saved.updatedAt,
  };
}

export interface WaiverSendResult {
  sent: boolean;
  organizerUrl: string | null;
  signUrl: string | null;
  reason: string | null;
}

/**
 * Send the waiver links to the host — through `notifyWaiverReminder`, the rail
 * the 7-day and 2-day crons already use, so the guest gets the same email and
 * text they would have got anyway and the CRM has not grown a second sender.
 *
 * The links themselves come back either way (`waiverLinksForReservation`), so
 * a legacy event with no contract row still gives the desk something to copy.
 */
export async function sendWaiverLinks(
  target: NotesTarget & { actor: string; origin?: string },
  deps: NotesDeps = defaultNotesDeps(),
): Promise<WaiverSendResult> {
  const centre = centreByCode(target.centre);
  const [quote, links] = await Promise.all([
    deps.getQuote(target.projectId).catch(() => null),
    deps
      .waiverLinks({
        centerCode: centre.centerCode,
        projectId: target.projectId,
        origin: target.origin,
      })
      .catch(() => null),
  ]);

  let sent = false;
  let reason: string | null = null;
  if (!quote) {
    reason = "no_contract";
  } else if (!hasWaiverRequiredActivities((quote.line_items || []) as Array<{ name: string }>)) {
    reason = "no_waiver_products";
  } else if (!links) {
    reason = "no_links";
  } else {
    await deps.notifyWaiver(quote);
    sent = true;
  }

  await deps.recordActivity({
    leadId: target.leadId,
    actorEmail: target.actor,
    kind: sent ? "system" : "note",
    direction: sent ? "out" : null,
    outcome: sent ? "waiver_link_sent" : `waiver_link_not_sent:${reason}`,
    subject: sent
      ? "Waiver link sent to the host"
      : "Waiver link not sent — the desk copied it instead",
    meta: { projectId: target.projectId, reason },
  });

  return {
    sent,
    organizerUrl: links?.organizerUrl ?? null,
    signUrl: links?.signUrl ?? null,
    reason,
  };
}
