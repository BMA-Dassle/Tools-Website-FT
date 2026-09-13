/**
 * The 7shifts roster mirror (brief B2 "mirror job pulls today+1 per location
 * for reps with `seven_shifts_user_id`, upserts `crm_shifts source='7shifts'`,
 * never overwrites `manual` rows") — plus the owner's 2026-09-13 decision
 * (§5.7b) that **Guest Services is a 7shifts DEPARTMENT, not a user**.
 *
 * Per run:
 *   0. ask each configured department (default `635186`, "Call Center", the
 *      HeadPinz Fort Myers call centre) for its ACTIVE users — a user row
 *      carries no department field, so `GET /users?department_id=` is the only
 *      way to know; their ids are the bucket's coverage set;
 *   1. per distinct location id, list live shifts for [today, tomorrow];
 *   2. a shift is stored when its `user_id` matches a rep's
 *      `seven_shifts_user_id` AND/OR belongs to a department member, in which
 *      case a SECOND row is written against the `gs` bucket — that is what
 *      makes the bucket "on shift" whenever anyone in the call centre is
 *      (`rosterForDate` unions the windows);
 *   3. upsert by (rep, date, 7shifts id) and prune mirrored rows for that
 *      location and window whose TRIPLE is gone upstream — a shift that moved
 *      day keeps its id, so pruning by id alone left the old day behind.
 *
 * Manual rows are a different `source` and are never selected by either write.
 * Department membership NEVER creates a `crm_rep_logins` row (see
 * `service/gs-members.ts` for why that would cost the directors their rows).
 *
 * Everything goes through `MirrorDeps` so the test drives it with an in-memory
 * store and a fake client; the job handler passes the real ones.
 */

import type { Centre, CrmRep } from "~/features/crm/core/types";
import type { SevenShift, SevenShiftsUserRaw } from "./sevenshifts";
import type { KeptShift, PruneInput, SevenShiftUpsert } from "../data/shifts-db";

export interface MirrorClient {
  listShifts(input: { locationId: number; fromYmd: string; toYmd: string }): Promise<SevenShift[]>;
  listUsers(input: { departmentId?: number }): Promise<SevenShiftsUserRaw[]>;
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
  /** `crm_reps.id` of the `gs` bucket; null = no bucket row, so no attribution. */
  gsRepId?: string | null;
  /** `crm_settings.sevenshifts.gsDepartmentIds`. */
  gsDepartmentIds?: readonly number[];
}

export interface MirrorDepartmentSummary {
  departmentId: number;
  users: number;
  error?: string;
}

export interface MirrorGsSummary {
  repId: string | null;
  departments: MirrorDepartmentSummary[];
  /** The 7shifts user ids whose shifts now cover the bucket. */
  userIds: number[];
}

export interface MirrorLocationSummary {
  locationId: number;
  centres: string[];
  fetched: number;
  matched: number;
  /** Of `matched`, how many rows were written against the Guest Services bucket. */
  gsRows: number;
  upserted: number;
  pruned: number;
  /** 7shifts user ids on shift that no rep row and no GS department claims. */
  unmatchedUserIds: number[];
  openShifts: number;
  error?: string;
}

export interface MirrorSummary {
  dates: [string, string];
  gs: MirrorGsSummary;
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

/** How the bucket is covered: which user ids count as Guest Services. */
export interface GsCoverage {
  repId: string | null;
  userIds: ReadonlySet<number>;
}

const NO_GS: GsCoverage = { repId: null, userIds: new Set<number>() };

/**
 * Shifts → upsert rows; only matched, only the two business dates. A shift
 * worked by a department member yields a bucket row as well as (not instead
 * of) the worker's own row, so a call-centre agent who is also a rep keeps
 * their personal roster line.
 */
export function shiftsToUpserts(
  shifts: readonly SevenShift[],
  byUser: Map<number, CrmRep>,
  dates: readonly string[],
  gs: GsCoverage = NO_GS,
): { rows: SevenShiftUpsert[]; unmatched: number[]; open: number; gsRows: number } {
  const rows: SevenShiftUpsert[] = [];
  const unmatched = new Set<number>();
  let open = 0;
  let gsRows = 0;
  for (const s of shifts) {
    if (s.userId === null) {
      open++;
      continue;
    }
    const rep = byUser.get(s.userId);
    const coversGs = gs.repId !== null && gs.userIds.has(s.userId);
    if (!rep && !coversGs) {
      unmatched.add(s.userId);
      continue;
    }
    if (!dates.includes(s.localDate)) continue;
    const base = {
      shiftDate: s.localDate,
      startsAt: s.start,
      endsAt: s.end,
      sevenShiftsShiftId: s.id,
      locationId: s.locationId,
    };
    if (rep) rows.push({ repId: rep.id, ...base });
    if (coversGs && gs.repId !== null && rep?.id !== gs.repId) {
      rows.push({ repId: gs.repId, ...base });
      gsRows++;
    }
  }
  return { rows, unmatched: [...unmatched].sort((a, b) => a - b), open, gsRows };
}

/** The (rep, date, shift id) triples a prune must keep. */
export function keptShifts(rows: readonly SevenShiftUpsert[]): KeptShift[] {
  return rows.map((r) => ({
    repId: r.repId,
    shiftDate: r.shiftDate,
    sevenShiftsShiftId: r.sevenShiftsShiftId,
  }));
}

/** Ask every configured department who is in it; one failing department is reported, not fatal. */
export async function loadGsCoverage(
  client: Pick<MirrorClient, "listUsers">,
  departmentIds: readonly number[],
  gsRepId: string | null,
): Promise<{ coverage: GsCoverage; departments: MirrorDepartmentSummary[] }> {
  const departments: MirrorDepartmentSummary[] = [];
  const userIds = new Set<number>();
  for (const departmentId of departmentIds) {
    try {
      const users = await client.listUsers({ departmentId });
      for (const u of users) if (typeof u.id === "number") userIds.add(u.id);
      departments.push({ departmentId, users: users.length });
    } catch (err) {
      departments.push({
        departmentId,
        users: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { coverage: { repId: gsRepId, userIds }, departments };
}

export async function mirrorSevenShifts(deps: MirrorDeps): Promise<MirrorSummary> {
  const dates: [string, string] = [deps.todayYmd, deps.tomorrowYmd];
  const byUser = repsBySevenShiftsUserId(deps.reps);
  const gsRepId = deps.gsRepId ?? null;
  const { coverage, departments } = await loadGsCoverage(
    deps.client,
    gsRepId === null ? [] : (deps.gsDepartmentIds ?? []),
    gsRepId,
  );
  const locations: MirrorLocationSummary[] = [];

  for (const loc of mirrorLocations(deps.centres)) {
    const summary: MirrorLocationSummary = {
      locationId: loc.locationId,
      centres: loc.centres,
      fetched: 0,
      matched: 0,
      gsRows: 0,
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
      const { rows, unmatched, open, gsRows } = shiftsToUpserts(shifts, byUser, dates, coverage);
      summary.matched = rows.length;
      summary.gsRows = gsRows;
      summary.unmatchedUserIds = unmatched;
      summary.openShifts = open;
      summary.upserted = await deps.store.upsertSevenShifts(rows);
      summary.pruned = await deps.store.pruneSevenShifts({
        locationId: loc.locationId,
        dates,
        keep: keptShifts(rows),
      });
    } catch (err) {
      // One location failing must not hide the others' rows; the job reports it.
      summary.error = err instanceof Error ? err.message : String(err);
    }
    locations.push(summary);
  }

  return {
    dates,
    gs: { repId: gsRepId, departments, userIds: [...coverage.userIds].sort((a, b) => a - b) },
    locations,
    repsWithoutSevenShiftsId: deps.reps
      .filter(
        (r) =>
          r.active && r.role !== "director" && r.id !== gsRepId && r.sevenShiftsUserId === null,
      )
      .map((r) => r.slug),
  };
}
