import "server-only";

/**
 * THE SHARED SESSION ROSTER CACHE — its key, its shape, and its cleaning rule,
 * stated once so the things that write it cannot drift apart.
 *
 * `pandora:participants:{locationId}:{sessionId}:R{0|1}` is read by a lot of
 * this codebase — the check-in scan lookup, pov-codes, checkin-race-flags, the
 * signage check-in progress band and race-checkin scene. For a long time it had
 * exactly one writer, the /api/pandora/session-participants proxy, warmed once a
 * minute by the check-in-alerts cron.
 *
 * The check-in board's own roster read is now a second writer (see rosterFor in
 * app/api/admin/checkin/route.ts), because it already pulls the same list every
 * ~10s to count it, and a cron that fails half its ticks on a bad Pandora night
 * is a poor thing for a scan lookup to depend on. Two writers of one key is only
 * safe if they agree completely on what belongs in it, hence this module.
 *
 * WHAT BELONGS IN IT: the UNPAID SUPERSET, cleaned.
 *
 *   - `excludeRemoved` is Pandora's own server-state filter (F_PAR_STATE = 5)
 *     and is the only thing we let it apply — we cannot reproduce it here. It is
 *     part of the key for that reason.
 *   - `excludeUnpaid` is ALWAYS false upstream. It is a filter callers apply for
 *     themselves, so the cache holds the superset and one entry serves every
 *     caller's combination. A writer that stored the paid-only slice would
 *     silently delete unpaid racers from every reader of this key — and an
 *     unpaid racer scanning their badge would be told they are not in any active
 *     session, at the desk, with the heat being called.
 *   - Null and placeholder rows are dropped BEFORE storing, so no reader has to
 *     re-filter.
 */

import type { Participant } from "@/lib/participant-contact";

/** 10 min — long enough to weather a Pandora outage. */
export const PARTICIPANTS_CACHE_TTL_SEC = 600;

/** The upstream query every writer of this cache must use. `excludeUnpaid` is
 *  pinned false: see the note above about the superset. */
export function rosterUpstreamQuery(excludeRemoved: boolean): string {
  return new URLSearchParams({
    excludeRemoved: String(excludeRemoved),
    excludeUnpaid: "false",
  }).toString();
}

export function participantsCacheKey(
  locationId: string,
  sessionId: string | number,
  excludeRemoved: boolean,
): string {
  return `pandora:participants:${locationId}:${sessionId}:R${excludeRemoved ? 1 : 0}`;
}

/**
 * Pandora returns rows with all-null fields, plus a known "DRIVER 1
 * PLACEHOLDER" id standing in for an unassigned seat. Neither is a person;
 * dropping them here means every cache reader gets a clean roster.
 */
const PLACEHOLDER_PERSON_IDS: ReadonlySet<string> = new Set(["17750277"]);

export function dropNullParticipants(participants: Participant[]): Participant[] {
  return participants.filter((p) => {
    if (p.personId == null) return false;
    const pidStr = String(p.personId).trim();
    if (!pidStr) return false;
    if (PLACEHOLDER_PERSON_IDS.has(pidStr)) return false;
    return true;
  });
}

/**
 * NEVER STORE AN EMPTY ROSTER. An empty list is what a degraded upstream and an
 * unbooked heat look like alike, and writing it would turn a bad minute into ten
 * minutes of a scan lookup that finds nobody. The existing entry — real people,
 * read successfully at some point — is strictly better than that.
 */
export function rosterIsWorthCaching(participants: Participant[]): boolean {
  return participants.length > 0;
}
