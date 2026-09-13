/**
 * The 7shifts roster mirror (brief B2 "mirror job pulls today+1 per location
 * for reps with `seven_shifts_user_id`, upserts `crm_shifts source='7shifts'`,
 * never overwrites `manual` rows").
 *
 * Per distinct location id (three centres → three 7shifts locations):
 *   1. list live shifts for [today, tomorrow] (ET business dates);
 *   2. keep those whose `user_id` matches a rep's `seven_shifts_user_id`
 *      (open shifts and other departments are counted, not stored);
 *   3. upsert them by 7shifts id; prune mirrored rows for that location and
 *      window whose id is gone upstream.
 * Manual rows are a different `source` and are never selected by either write.
 *
 * Everything goes through `MirrorDeps` so the test drives it with an in-memory
 * store and a fake client; the job handler passes the real ones.
 */

import type { Centre, CrmRep } from "~/features/crm/core/types";
import type { SevenShift } from "./sevenshifts";
import type { PruneInput, SevenShiftUpsert } from "../data/shifts-db";

export interface MirrorClient {
  listShifts(input: { locationId: number; fromYmd: string; toYmd: string }): Promise<SevenShift[]>;
}

export interface MirrorStore {
  upsertSevenShifts(rows: readonly SevenShiftUpsert[]): Promise<number>;
  pruneSevenShifts(input: PruneInput): Promise<number>;
}

export interface MirrorDeps {
  client: MirrorClient;
  store: MirrorStore;
  reps: readonly CrmRep[];
  centres: readonly Centre[];
  todayYmd: string;
  tomorrowYmd: string;
}

export interface MirrorLocationSummary {
  locationId: number;
  centres: string[];
  fetched: number;
  matched: number;
  upserted: number;
  pruned: number;
  /** 7shifts user ids on shift that no rep row claims — the owner fills them in. */
  unmatchedUserIds: number[];
  openShifts: number;
  error?: string;
}

export interface MirrorSummary {
  dates: [string, string];
  locations: MirrorLocationSummary[];
  /** Reps with no `seven_shifts_user_id` — nothing can be mirrored for them. */
  repsWithoutSevenShiftsId: string[];
}

/** The distinct 7shifts locations in centre order. */
export function mirrorLocations(
  centres: readonly Centre[],
): { locationId: number; centres: string[] }[] {
  const out: { locationId: number; centres: string[] }[] = [];
  for (const c of centres) {
    const hit = out.find((x) => x.locationId === c.sevenShiftsLocationId);
    if (hit) hit.centres.push(c.code);
    else out.push({ locationId: c.sevenShiftsLocationId, centres: [c.code] });
  }
  return out;
}

/** 7shifts user id → rep, over active reps that have one. */
export function repsBySevenShiftsUserId(reps: readonly CrmRep[]): Map<number, CrmRep> {
  const m = new Map<number, CrmRep>();
  for (const r of reps) if (r.active && r.sevenShiftsUserId !== null) m.set(r.sevenShiftsUserId, r);
  return m;
}

/** Shifts → upsert rows; only matched, only the two business dates. */
export function shiftsToUpserts(
  shifts: readonly SevenShift[],
  byUser: Map<number, CrmRep>,
  dates: readonly string[],
): { rows: SevenShiftUpsert[]; unmatched: number[]; open: number } {
  const rows: SevenShiftUpsert[] = [];
  const unmatched = new Set<number>();
  let open = 0;
  for (const s of shifts) {
    if (s.userId === null) {
      open++;
      continue;
    }
    const rep = byUser.get(s.userId);
    if (!rep) {
      unmatched.add(s.userId);
      continue;
    }
    if (!dates.includes(s.localDate)) continue;
    rows.push({
      repId: rep.id,
      shiftDate: s.localDate,
      startsAt: s.start,
      endsAt: s.end,
      sevenShiftsShiftId: s.id,
      locationId: s.locationId,
    });
  }
  return { rows, unmatched: [...unmatched].sort((a, b) => a - b), open };
}

export async function mirrorSevenShifts(deps: MirrorDeps): Promise<MirrorSummary> {
  const dates: [string, string] = [deps.todayYmd, deps.tomorrowYmd];
  const byUser = repsBySevenShiftsUserId(deps.reps);
  const locations: MirrorLocationSummary[] = [];

  for (const loc of mirrorLocations(deps.centres)) {
    const summary: MirrorLocationSummary = {
      locationId: loc.locationId,
      centres: loc.centres,
      fetched: 0,
      matched: 0,
      upserted: 0,
      pruned: 0,
      unmatchedUserIds: [],
      openShifts: 0,
    };
    try {
      const shifts = await deps.client.listShifts({
        locationId: loc.locationId,
        fromYmd: deps.todayYmd,
        toYmd: deps.tomorrowYmd,
      });
      summary.fetched = shifts.length;
      const { rows, unmatched, open } = shiftsToUpserts(shifts, byUser, dates);
      summary.matched = rows.length;
      summary.unmatchedUserIds = unmatched;
      summary.openShifts = open;
      summary.upserted = await deps.store.upsertSevenShifts(rows);
      summary.pruned = await deps.store.pruneSevenShifts({
        locationId: loc.locationId,
        dates,
        keepShiftIds: rows.map((r) => r.sevenShiftsShiftId),
      });
    } catch (err) {
      // One location failing must not hide the others' rows; the job reports it.
      summary.error = err instanceof Error ? err.message : String(err);
    }
    locations.push(summary);
  }

  return {
    dates,
    locations,
    repsWithoutSevenShiftsId: deps.reps
      .filter((r) => r.active && r.role !== "director" && r.sevenShiftsUserId === null)
      .map((r) => r.slug),
  };
}
