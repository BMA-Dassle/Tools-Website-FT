/**
 * Window arithmetic for the mirror, PURE (brief B1 "window arithmetic + cursor
 * re-enqueue, delta overlap"; §3.9 "no single job may assume more than the 45 s
 * deadline").
 *
 * BACKFILL: one 30-day dayPlanner window per job run, and the detail phase of
 * a big window is itself chunked — the cursor carries the window's project
 * list and an offset, so a run that has read 80 project details re-enqueues
 * ITSELF (same window, offset advanced) and only then the NEXT window. Every
 * key is derived from the cursor, never from a clock, and carries the chain
 * id so a second backfill of the same span (a director re-running it after a
 * fix) is a new chain rather than a set of `done` rows nobody re-runs.
 *
 * DELTA: `liveReservations` filters by created/modified stamp, so the window
 * is `[last successful until − 10 min, now]` — the overlap is what makes a
 * run that dies mid-way harmless. Scheduled on 5-minute buckets.
 *
 * DATES are ET calendar days (`shiftYmd`, R10) and Office wall-clock stamps are
 * ET, formatted without a zone.
 */

import { daysBetweenYmd, shiftYmd, todayEasternYmd } from "../../core/dates";
import type { JobKind } from "../../core/types";

export const BACKFILL_WINDOW_DAYS = 30;
/** Project details read per run before the cursor re-enqueues itself. */
export const BACKFILL_DETAIL_BATCH = 80;
/** Stop reading details after this many ms and hand the rest to the next run. */
export const BACKFILL_TIME_BUDGET_MS = 30_000;

export const DELTA_OVERLAP_MS = 10 * 60_000;
/** A tenant that has never had a successful delta looks back this far. */
export const DELTA_FIRST_LOOKBACK_MS = 24 * 3_600_000;
export const DELTA_BUCKET_MS = 5 * 60_000;

export const BACKFILL_KIND: JobKind = "bmi-mirror-backfill";
export const DELTA_KIND: JobKind = "bmi-mirror-delta";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function isYmd(v: unknown): v is string {
  return typeof v === "string" && YMD.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));
}

export interface Window {
  from: string;
  till: string;
}

/** Inclusive 30-day windows covering `[from, until]`; empty when reversed. */
export function backfillWindows(
  from: string,
  until: string,
  days = BACKFILL_WINDOW_DAYS,
): Window[] {
  const out: Window[] = [];
  if (!isYmd(from) || !isYmd(until) || from > until) return out;
  let cursor = from;
  while (cursor <= until) {
    const till = shiftYmd(cursor, days - 1);
    out.push({ from: cursor, till: till < until ? till : until });
    cursor = shiftYmd(cursor, days);
  }
  return out;
}

/** The window after `windowUntil`, or null past `until`. */
export function nextWindow(
  windowUntil: string,
  until: string,
  days = BACKFILL_WINDOW_DAYS,
): Window | null {
  const from = shiftYmd(windowUntil, 1);
  if (from > until) return null;
  const till = shiftYmd(from, days - 1);
  return { from, till: till < until ? till : until };
}

// ---------------------------------------------------------------------------
// The backfill cursor (the job payload)
// ---------------------------------------------------------------------------

export interface BackfillCursor {
  clientKey: string;
  /** The whole span the director asked for. */
  from: string;
  until: string;
  /** The window this run processes. */
  windowFrom: string;
  windowUntil: string;
  /** Detail phase: how many of `projectIds` are already mirrored. */
  detailOffset: number;
  /** The window's deduped project ids, once the dayPlanner phase has run. */
  projectIds: string[] | null;
  /** Resource ids per project from the dayPlanner schedules (location split). */
  scheduleResources: Record<string, string[]> | null;
  /** Ties the run's keys together; a re-run is a new chain. */
  chain: string;
}

export type CursorParse = { ok: true; cursor: BackfillCursor } | { ok: false; error: string };

/**
 * Validate a job payload into a cursor. A fresh `{clientKey, from, until}` (what
 * the director posts) starts at the first window; a continuation carries every
 * field. `chainFallback` is what a first run uses as its chain id (the job id).
 */
export function parseBackfillPayload(
  payload: Record<string, unknown>,
  chainFallback: string,
): CursorParse {
  const clientKey = typeof payload.clientKey === "string" ? payload.clientKey.trim() : "";
  if (!clientKey) return { ok: false, error: "payload.clientKey is required" };
  const from = payload.from;
  const until = payload.until;
  if (!isYmd(from) || !isYmd(until)) {
    return { ok: false, error: "payload.from / payload.until must be YYYY-MM-DD" };
  }
  if (from > until) return { ok: false, error: "payload.from is after payload.until" };
  if (daysBetweenYmd(from, until) > 366 * 5) {
    return { ok: false, error: "payload span exceeds five years" };
  }
  const first = backfillWindows(from, until)[0];
  if (!first) return { ok: false, error: "payload span is empty" };
  const windowFrom = isYmd(payload.windowFrom) ? payload.windowFrom : first.from;
  const windowUntil = isYmd(payload.windowUntil) ? payload.windowUntil : first.till;
  if (windowFrom < from || windowUntil > until || windowFrom > windowUntil) {
    return { ok: false, error: "payload window lies outside the span" };
  }
  const detailOffset =
    typeof payload.detailOffset === "number" &&
    Number.isInteger(payload.detailOffset) &&
    payload.detailOffset >= 0
      ? payload.detailOffset
      : 0;
  const projectIds = Array.isArray(payload.projectIds)
    ? payload.projectIds.filter((x): x is string => typeof x === "string" && x !== "")
    : null;
  const scheduleResources =
    payload.scheduleResources &&
    typeof payload.scheduleResources === "object" &&
    !Array.isArray(payload.scheduleResources)
      ? (payload.scheduleResources as Record<string, string[]>)
      : null;
  const chain = typeof payload.chain === "string" && payload.chain ? payload.chain : chainFallback;
  return {
    ok: true,
    cursor: {
      clientKey,
      from,
      until,
      windowFrom,
      windowUntil,
      detailOffset,
      projectIds,
      scheduleResources,
      chain,
    },
  };
}

/** `bmi-mirror-backfill:<ck>:<windowFrom>[:d<offset>]#<chain>` (brief §B1 key + chain). */
export function backfillJobKey(
  c: Pick<BackfillCursor, "clientKey" | "windowFrom" | "detailOffset" | "chain">,
): string {
  const offset = c.detailOffset > 0 ? `:d${c.detailOffset}` : "";
  return `${BACKFILL_KIND}:${c.clientKey}:${c.windowFrom}${offset}#${c.chain}`;
}

export type BackfillStep =
  | { kind: "continue"; cursor: BackfillCursor }
  | { kind: "next-window"; cursor: BackfillCursor }
  | { kind: "finished" };

/**
 * What to enqueue after a run that mirrored `detailsDone` of the window's
 * `total` projects: the same window with the offset advanced, the next window
 * fresh, or nothing.
 */
export function planAfterRun(
  cursor: BackfillCursor,
  detailsDone: number,
  total: number,
): BackfillStep {
  const offset = cursor.detailOffset + detailsDone;
  if (offset < total) {
    return { kind: "continue", cursor: { ...cursor, detailOffset: offset } };
  }
  const next = nextWindow(cursor.windowUntil, cursor.until);
  if (!next) return { kind: "finished" };
  return {
    kind: "next-window",
    cursor: {
      ...cursor,
      windowFrom: next.from,
      windowUntil: next.till,
      detailOffset: 0,
      projectIds: null,
      scheduleResources: null,
    },
  };
}

/** The slice of ids this run reads: from the offset, at most the batch. */
export function detailSlice(cursor: BackfillCursor, batch = BACKFILL_DETAIL_BATCH): string[] {
  const ids = cursor.projectIds ?? [];
  return ids.slice(cursor.detailOffset, cursor.detailOffset + batch);
}

// ---------------------------------------------------------------------------
// Delta windows
// ---------------------------------------------------------------------------

export interface DeltaWindow {
  from: Date;
  until: Date;
}

/** `[lastOkUntil − 10 min, now]`, or the first 24 h look-back when never run. */
export function deltaWindow(lastOkUntil: Date | null, now: Date): DeltaWindow {
  const from = lastOkUntil
    ? new Date(lastOkUntil.getTime() - DELTA_OVERLAP_MS)
    : new Date(now.getTime() - DELTA_FIRST_LOOKBACK_MS);
  return { from: from < now ? from : new Date(now.getTime() - DELTA_OVERLAP_MS), until: now };
}

/** Floor to the 5-minute bucket, as an ISO instant. */
export function fiveMinuteBucket(now: Date): string {
  return new Date(Math.floor(now.getTime() / DELTA_BUCKET_MS) * DELTA_BUCKET_MS).toISOString();
}

/** The bucket after `now`'s — when the self-chaining delta should run next. */
export function nextBucketStart(now: Date): Date {
  return new Date((Math.floor(now.getTime() / DELTA_BUCKET_MS) + 1) * DELTA_BUCKET_MS);
}

/** `bmi-mirror-delta:<ck>:<5-min-bucket>` (brief §3.9). */
export function deltaJobKey(clientKey: string, bucketIso: string): string {
  return `${DELTA_KIND}:${clientKey}:${bucketIso}`;
}

/**
 * THE sub's idempotency-key helper for the scheduler (§5.7b: "each sub exports
 * its idempotency-key helper … B1: the delta bucket"). The B3 wiring stage's
 * `enqueueScheduled(now)` in `/api/cron/crm-jobs` calls this once per tenant
 * and enqueues `bmi-mirror-delta` with the key, ON CONFLICT DO NOTHING — so
 * two cron ticks inside one 5-minute bucket produce one job, and the key is a
 * pure function of the bucket, never of the call.
 */
export function deltaIdempotencyKey(now: Date, clientKey: string): string {
  return deltaJobKey(clientKey, fiveMinuteBucket(now));
}

const ET_WALL = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** An instant as Office's zone-less ET wall clock: `YYYY-MM-DDTHH:mm:ss`. */
export function etWallClock(d: Date): string {
  const parts = Object.fromEntries(ET_WALL.formatToParts(d).map((p) => [p.type, p.value]));
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}`;
}

// ---------------------------------------------------------------------------
// "This time last year"
// ---------------------------------------------------------------------------

/** 3 to 8 weeks ahead of `today` (the reach-out horizon) — how far out a group books. */
export const LAST_YEAR_LEAD_DAYS = 21;
export const LAST_YEAR_HORIZON_DAYS = 56;

/** Same month/day one year earlier; Feb 29 → Feb 28. */
export function shiftYears(ymd: string, years: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const yy = (y ?? 0) + years;
  const anchor = new Date(Date.UTC(yy, (m ?? 1) - 1, d ?? 1, 12));
  if (anchor.getUTCMonth() !== (m ?? 1) - 1) {
    // Feb 29 in a non-leap target year rolled into March: clamp to the 28th.
    return `${yy}-02-28`;
  }
  return `${yy}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * The ET calendar window the History screen's "This time last year" list
 * covers: the events that happened 3–8 weeks from today, one year ago (the
 * prototype's pill at Sep 12 2026 reads "Oct 5 – Nov 7, 2025").
 */
export function lastYearWindow(now: Date = new Date()): Window {
  const today = todayEasternYmd(now);
  return {
    from: shiftYears(shiftYmd(today, LAST_YEAR_LEAD_DAYS), -1),
    till: shiftYears(shiftYmd(today, LAST_YEAR_HORIZON_DAYS), -1),
  };
}
