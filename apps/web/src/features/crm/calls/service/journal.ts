/**
 * Turning 3CX's two ways of telling us about a call into ONE `crm_calls` row.
 *
 *   1. the PBX's CRM-Integration template POSTs `/api/crm/3cx/journal` as the
 *      call ends (`recordJournalCall`);
 *   2. the `threecx-reconcile` job reads the call log and sweeps up everything
 *      the template missed or never sent (`reconcileCalls`).
 *
 * Both land on `upsertCall`, whose conflict arm is keyed on
 * `threecx_call_id` — so either order, and any number of replays, converge
 * (brief §4 C3: "the reconcile job dedupes on the 3CX call id").
 *
 * THE SHAPE THAT MADE THIS TRICKY, probed live 2026-09-13 (`docs/crm/3cx.md`):
 * one guest call is SEVERAL CDR rows sharing one `CallHistoryId` — a
 * `Digital Receptionist` leg, an `Inbound Queue` leg with `Status: "Waiting"`,
 * then the `Extension` leg somebody answered. Writing each row would give the
 * Calls screen three entries for one conversation, two of them meaningless.
 * `groupCallLog` folds them: one call per `CallHistoryId`, preferring the
 * answered extension leg, summing nothing and inventing nothing.
 *
 * PURE WHERE IT CAN BE. `parseIsoDuration`, `externalNumbers`, `foldLegs` and
 * `groupCallLog` take rows in and give calls out with no Neon and no network,
 * so the ugly cases are unit-tested against the captured fixture.
 */

import { listReps } from "../../reps";
import type { CrmRep, Direction } from "../../core/types";
import { upsertCall, latestCallStartedAt, type CallUpsert } from "../data/calls-db";
import type { CallRow } from "../contracts";
import { callerLabel, isExtensionDn, matchNumber, repForExtension, toE164 } from "./match";
import { fetchCallLog, type CallLogRow } from "./threecx";

// ---------------------------------------------------------------------------
// Pure: CDR rows → calls
// ---------------------------------------------------------------------------

/**
 * `PT1M12.577027S` → 72. 3CX sends ISO-8601 durations, and `PT0S` is common.
 * Anything unparseable is 0, never NaN — a NaN would reach `duration_seconds`
 * as null and silently drop a call's length.
 */
export function parseIsoDuration(value: string | null | undefined): number {
  if (!value) return 0;
  const m =
    /^P(?:(\d+(?:\.\d+)?)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(
      String(value).trim(),
    );
  if (!m) return 0;
  const [, d, h, min, s] = m;
  const total =
    Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(min ?? 0) * 60 + Number(s ?? 0);
  return Number.isFinite(total) ? Math.round(total) : 0;
}

/** A CDR leg, reduced to the two things that matter: who was outside, and on which DN. */
export interface LegParties {
  /** The external party's E.164, or null when both ends are internal. */
  external: string | null;
  /** The internal DN that handled this leg, or null. */
  extension: string | null;
  /** What the PBX called the external party, when it is a name rather than the number. */
  externalName: string | null;
}

/**
 * Which end of this leg is the guest?
 *
 * Inbound: `SourceDn` is the trunk (`10000`) and `SourceCallerId` is the
 * guest's E.164; `DestinationDn` is ours. Outbound: exactly reversed. We do not
 * trust `Direction` for this — we look at which side has a dialable number and
 * which side has a DN — because a transferred leg can carry either.
 */
export function legParties(row: CallLogRow): LegParties {
  const outbound = String(row.Direction ?? "").startsWith("Outbound");
  const guestCallerId = outbound ? row.DestinationCallerId : row.SourceCallerId;
  const guestName = outbound ? row.DestinationDisplayName : row.SourceDisplayName;
  const ourDn = outbound ? row.SourceDn : row.DestinationDn;
  // A caller id that is itself a short DN is an extension, not a guest — that is
  // how an internal or transferred leg shows up on the "outside" side.
  const external = isExtensionDn(guestCallerId) ? null : toE164(guestCallerId);
  return {
    external,
    extension: isExtensionDn(ourDn) ? String(ourDn) : null,
    externalName: callerLabel(guestName, guestCallerId),
  };
}

/** The CRM's own two directions; `Internal` calls are dropped before this. */
export function legDirection(row: CallLogRow): Direction {
  return String(row.Direction ?? "").startsWith("Outbound") ? "out" : "in";
}

/** A call as the CRM stores it, before Neon knows about it. */
export interface NormalizedCall {
  threecxCallId: string;
  direction: Direction;
  external: string | null;
  guestName: string | null;
  extension: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number;
  /** `Answered` | `Unanswered` — the fold's verdict, never a queue's `Waiting`. */
  status: "Answered" | "Unanswered";
  callType: string | null;
  recordingUrl: string | null;
  legs: number;
}

/** A call whose only legs are internal, or which has no external party at all. */
function isInternalOnly(legs: readonly CallLogRow[]): boolean {
  return legs.every((r) => String(r.Direction ?? "") === "Internal");
}

const ANSWERED_EXTENSION = (r: CallLogRow): boolean =>
  r.Answered === true && r.CallType === "Extension" && isExtensionDn(r.DestinationDn ?? r.SourceDn);

/**
 * Fold every leg of ONE call into one row.
 *
 * The winning leg — the one whose extension and talk time we keep — is, in
 * order: an answered `Extension` leg, then any answered leg, then the last leg.
 * `startedAt` is the EARLIEST leg (the guest's call began when the IVR picked
 * up, not when a human did); `endedAt` is the latest leg's start plus its talk
 * time. A call is `Answered` only if some leg reached an extension: a queue leg
 * with `Answered: true, Status: "Waiting"` is the PBX saying the QUEUE picked
 * up, which is not a person, and must never read as "reached".
 */
export function foldLegs(callId: string, legs: readonly CallLogRow[]): NormalizedCall | null {
  if (legs.length === 0) return null;
  const ordered = [...legs].sort(
    (a, b) => Date.parse(a.StartTime ?? "") - Date.parse(b.StartTime ?? ""),
  );
  const winner =
    ordered.find(ANSWERED_EXTENSION) ??
    ordered.find((r) => r.Answered === true) ??
    ordered[ordered.length - 1];
  const parties = legParties(winner);
  const withNumber = parties.external ? parties : ordered.map(legParties).find((p) => p.external);
  const talk = parseIsoDuration(winner.TalkingDuration);
  const firstStart = ordered[0]?.StartTime ? new Date(ordered[0].StartTime) : null;
  const lastLeg = ordered[ordered.length - 1];
  const lastStart = lastLeg?.StartTime ? new Date(lastLeg.StartTime) : null;
  const endedAt = lastStart
    ? new Date(lastStart.getTime() + parseIsoDuration(lastLeg.TalkingDuration) * 1000)
    : null;

  return {
    threecxCallId: callId,
    direction: legDirection(winner),
    external: withNumber?.external ?? null,
    guestName: withNumber?.externalName ?? null,
    extension: parties.extension,
    startedAt: firstStart,
    endedAt,
    durationSeconds: talk,
    status: ordered.some(ANSWERED_EXTENSION) ? "Answered" : "Unanswered",
    callType: winner.CallType ?? null,
    recordingUrl: ordered.find((r) => r.RecordingUrl)?.RecordingUrl ?? null,
    legs: ordered.length,
  };
}

/**
 * Every external call in a call-log page, one entry each, newest first.
 * Internal extension-to-extension chatter is dropped — the CRM is about guests.
 */
export function groupCallLog(rows: readonly CallLogRow[]): NormalizedCall[] {
  const byCall = new Map<string, CallLogRow[]>();
  for (const r of rows) {
    const id = r.CallHistoryId || r.MainCallHistoryId || r.CdrId;
    if (!id) continue;
    const bucket = byCall.get(id);
    if (bucket) bucket.push(r);
    else byCall.set(id, [r]);
  }
  const out: NormalizedCall[] = [];
  for (const [id, legs] of byCall) {
    if (isInternalOnly(legs)) continue;
    const call = foldLegs(id, legs);
    if (!call || !call.external) continue;
    out.push(call);
  }
  return out.sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));
}

// ---------------------------------------------------------------------------
// Persisting
// ---------------------------------------------------------------------------

export interface PersistDeps {
  reps: () => Promise<CrmRep[]>;
  match: typeof matchNumber;
  save: typeof upsertCall;
}

export const defaultPersistDeps: PersistDeps = {
  reps: () => listReps(),
  match: matchNumber,
  save: upsertCall,
};

/** Neon-first (R2): the row exists before anything else is decided about it. */
export async function persistCall(
  call: NormalizedCall,
  source: "journal" | "reconcile",
  deps: PersistDeps = defaultPersistDeps,
  reps?: readonly CrmRep[],
): Promise<CallRow | null> {
  const roster = reps ?? (await deps.reps());
  const rep = repForExtension(call.extension, roster);
  const match = await deps.match(call.external);
  const row: CallUpsert = {
    threecxCallId: call.threecxCallId,
    direction: call.direction,
    fromE164: call.direction === "in" ? call.external : null,
    toE164: call.direction === "out" ? call.external : null,
    extension: call.extension,
    repId: rep?.id ?? match.repId,
    leadId: match.leadId,
    contactId: match.contactId,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    answeredAt: call.status === "Answered" ? call.startedAt : null,
    durationSeconds: call.durationSeconds,
    status: call.status,
    callType: call.callType,
    guestName: call.guestName,
    recordingUrl: call.recordingUrl,
    source,
    raw: { legs: call.legs },
  };
  return deps.save(row);
}

// ---------------------------------------------------------------------------
// The journal POST (public route)
// ---------------------------------------------------------------------------

/** What the PBX's CRM template sends us as a call ends. */
export interface JournalPayload {
  callId: string;
  direction: Direction;
  number: string;
  extension?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  /** Seconds of talk time. */
  duration?: number | null;
  status?: string | null;
  name?: string | null;
}

/**
 * One journalled call. The template fires per call, not per leg, so there is
 * nothing to fold — but the row still goes through `upsertCall`, so a reconcile
 * run that saw the same `CallHistoryId` merges rather than duplicating.
 */
export async function recordJournalCall(
  payload: JournalPayload,
  deps: PersistDeps = defaultPersistDeps,
): Promise<CallRow | null> {
  const started = payload.startedAt ? new Date(payload.startedAt) : null;
  const ended = payload.endedAt ? new Date(payload.endedAt) : null;
  const answered = String(payload.status ?? "")
    .toLowerCase()
    .startsWith("answer");
  return persistCall(
    {
      threecxCallId: payload.callId,
      direction: payload.direction,
      external: toE164(payload.number),
      guestName: callerLabel(payload.name, payload.number),
      extension: payload.extension ? String(payload.extension) : null,
      startedAt: started && !Number.isNaN(started.getTime()) ? started : new Date(),
      endedAt: ended && !Number.isNaN(ended.getTime()) ? ended : null,
      durationSeconds: Math.max(0, Math.round(Number(payload.duration ?? 0)) || 0),
      status: answered ? "Answered" : "Unanswered",
      callType: null,
      recordingUrl: null,
      legs: 1,
    },
    "journal",
    deps,
  );
}

// ---------------------------------------------------------------------------
// The reconcile job
// ---------------------------------------------------------------------------

/** How far back a reconcile run looks when nothing has been stored yet. */
export const RECONCILE_COLD_START_HOURS = 24;
/** How far back it looks past the newest row we hold — late legs and clock skew. */
export const RECONCILE_OVERLAP_MINUTES = 15;
/** The job's own ceiling; `fetchCallLog` clamps to 500 anyway. */
export const RECONCILE_MAX_ROWS = 500;

export interface ReconcileDeps extends PersistDeps {
  fetch: typeof fetchCallLog;
  since: typeof latestCallStartedAt;
}

export const defaultReconcileDeps: ReconcileDeps = {
  ...defaultPersistDeps,
  fetch: fetchCallLog,
  since: latestCallStartedAt,
};

export interface ReconcileResult {
  from: string;
  to: string;
  rowsSeen: number;
  callsSeen: number;
  callsWritten: number;
  /** CDR legs the fold dropped: internal chatter and calls with no outside party. */
  legsSkipped: number;
}

/**
 * Read the window since the newest call we already hold (minus an overlap) and
 * upsert every external call in it.
 *
 * Chunked by construction (§3.9): the window is bounded and the page is capped
 * at 500 rows, so the job always finishes well inside the 45 s drain deadline.
 * A cold start looks back 24 h rather than "everything", because the PBX holds
 * years of CDRs and a first run must not try to swallow them.
 */
export async function reconcileCalls(
  opts: { now?: Date; from?: Date; to?: Date } = {},
  deps: ReconcileDeps = defaultReconcileDeps,
): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  const newest = opts.from ? null : await deps.since();
  const from =
    opts.from ??
    (newest
      ? new Date(newest.getTime() - RECONCILE_OVERLAP_MINUTES * 60_000)
      : new Date(now.getTime() - RECONCILE_COLD_START_HOURS * 3_600_000));
  const to = opts.to ?? now;

  const rows = await deps.fetch({ from, to, top: RECONCILE_MAX_ROWS });
  const calls = groupCallLog(rows);
  const roster = await deps.reps();
  let written = 0;
  for (const call of calls) {
    const saved = await persistCall(call, "reconcile", deps, roster);
    if (saved) written++;
  }
  const legsKept = calls.reduce((n, c) => n + c.legs, 0);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    rowsSeen: rows.length,
    callsSeen: calls.length,
    callsWritten: written,
    legsSkipped: Math.max(0, rows.length - legsKept),
  };
}

/**
 * The scheduled kind's idempotency key (§5.7b: each sub exports its own; the
 * cron route enqueues whichever kinds exist). One run per five-minute bucket,
 * so a cron that fires every two minutes cannot stack three reconciles.
 */
export function reconcileIdempotencyKey(now: Date = new Date()): string {
  const bucket = new Date(Math.floor(now.getTime() / 300_000) * 300_000);
  return `threecx-reconcile:${bucket.toISOString().slice(0, 16)}`;
}
