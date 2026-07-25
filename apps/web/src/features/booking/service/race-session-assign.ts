/**
 * Race session-assignment backstop — pure helpers for the
 * `race-session-assign-sweep` cron.
 *
 * WHY: the reserve rail (kiosk-post-reserve `runKioskPostReserve`) checks racers
 * into their Pandora race session with a best-effort POST + a few in-request
 * retries. When Pandora's `/bmi/schedule` endpoint 500s through that whole
 * window (a vendor rough patch, live 2026-07-25 — W54403/04/17/25 all came back
 * "0 racers linked"), the racers are dropped and only a staff memo catches it —
 * they show up in BMI with EMPTY "Assign schedules" boxes. There is no async
 * backstop that re-drives the assignment once Pandora recovers (it does recover
 * within minutes). This module is that backstop's brain.
 *
 * The racer→heat mapping is already persisted at booking time as
 * `booking_metadata.heats` (checkout.ts raceHeatsMetadata) — the SAME source the
 * v2/reserve credit path feeds to `buildKioskRacersFromHeats`. So the sweep
 * reproduces the EXACT payload the live rail attempted; re-POSTing is idempotent
 * (Pandora returns `already_linked`), so a healthy booking is a safe no-op.
 *
 * These functions are pure (no network) so the link-completeness decision — the
 * part that gates the Redis "done" flag — is unit-tested. The cron owns the
 * fetch + Redis + logging glue.
 */
import { buildKioskRacersFromHeats } from "./kiosk-post-reserve";

/** One racer→heat row, exactly as `buildKioskRacersFromHeats` emits it. */
export type AssignRacer = ReturnType<typeof buildKioskRacersFromHeats>[number];

/** Per-racer link key — personId + heat block start (the same identity Pandora
 *  keys `already_linked` on). */
export function racerKey(r: { personId?: string | null; heatStart?: string | null }): string {
  return `${r.personId}|${r.heatStart}`;
}

/**
 * Rebuild the racer→heat rows for a reservation from its persisted
 * `booking_metadata`. Returns [] when the row carries no race heats (a
 * non-race/legacy row), so the caller can skip it.
 */
export function racersFromMetadata(
  meta: Record<string, unknown> | undefined | null,
): AssignRacer[] {
  const heats = Array.isArray((meta as { heats?: unknown })?.heats)
    ? (meta as { heats: Array<Record<string, unknown>> }).heats
    : [];
  return buildKioskRacersFromHeats(heats);
}

/** The subset the schedule endpoint can actually place — a resolved short
 *  personId AND a heat start. A racer missing either can never auto-link (no
 *  Pandora person yet) and is a staff-desk job, not a sweep job. */
export function assignableRacers(racers: AssignRacer[]): AssignRacer[] {
  return racers.filter((r) => r.personId && r.heatStart);
}

/** Shape of Pandora's `POST /bmi/schedule` response body (the bits we read). */
export interface ScheduleResponseData {
  success?: boolean;
  data?: {
    inserted?: number;
    results?: Array<{ personId?: string; heatStart?: string; status?: string }>;
  };
}

export interface LinkSummary {
  /** How many of `assignable` are confirmed on the grid after this response. */
  linked: number;
  /** Distinct racer names still NOT linked (drives retry + the memo/alert). */
  missing: string[];
  /** True when every assignable racer is confirmed linked. */
  complete: boolean;
}

/**
 * Fold a schedule response against the racers we tried to place.
 *
 *  - Per-racer `results` (Pandora ≥2.4.57): trust exactly who came back
 *    `inserted` / `already_linked`; everyone else is still missing.
 *  - Count-only `inserted`: we know HOW MANY but not WHICH, so we only declare
 *    completion when the count covers the whole batch — a partial count-only
 *    response leaves everyone "missing" so the next tick re-POSTs (idempotent;
 *    never a double-link because already-placed racers return `already_linked`).
 *  - Non-OK / `success:false`: nothing linked, everyone missing.
 */
export function summarizeLink(
  assignable: AssignRacer[],
  ok: boolean,
  data: ScheduleResponseData | null,
): LinkSummary {
  if (assignable.length === 0) return { linked: 0, missing: [], complete: true };
  if (!ok || !data?.success) {
    return { linked: 0, missing: distinctNames(assignable), complete: false };
  }
  const results = data.data?.results;
  if (Array.isArray(results)) {
    const linkedKeys = new Set<string>();
    for (const row of results) {
      if (row.status === "inserted" || row.status === "already_linked") {
        linkedKeys.add(racerKey(row));
      }
    }
    const missing = assignable.filter((r) => !linkedKeys.has(racerKey(r)));
    return {
      linked: assignable.length - missing.length,
      missing: distinctNames(missing),
      complete: missing.length === 0,
    };
  }
  // Count-only.
  const inserted = data.data?.inserted ?? 0;
  if (inserted >= assignable.length) {
    return { linked: assignable.length, missing: [], complete: true };
  }
  return { linked: 0, missing: distinctNames(assignable), complete: false };
}

function distinctNames(racers: AssignRacer[]): string[] {
  return [...new Set(racers.map((r) => r.racerName))];
}
