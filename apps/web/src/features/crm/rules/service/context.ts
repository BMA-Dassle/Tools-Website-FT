/**
 * `loadEngineContext(centre, now)` — the one place the engine's inputs are
 * assembled from Neon: the roster (`crm_reps`), the rules
 * (`crm_assignment_rules`), today's and tomorrow's shifts (`crm_shifts`, ET
 * business dates from `now`) and the open volume per rep per party month
 * (`crm_leads`, read-only).
 *
 * The context is the SAME for every centre — the engine narrows candidates by
 * the lead's own centre — so `centre` is recorded on the result (the try-lead
 * response echoes it, the sweep loads once per run) rather than used to
 * pre-filter reps; pre-filtering would change the R4 note for FT leads when a
 * Fort Myers rep is off.
 */

import { shiftYmd, todayEasternYmd } from "~/features/crm/core/dates";
import type { CentreCode } from "~/features/crm/core/types";
import { listReps } from "~/features/crm/reps";
import { listRules } from "../data/rules-db";
import { listShiftsForDates } from "../data/shifts-db";
import { loadOpenVolumeByRepMonth } from "../data/volume-db";
import { rosterFromShiftRows, type ShiftRow } from "./availability";
import type { EngineContext } from "./engine";

export interface LoadedEngineContext extends EngineContext {
  centre: CentreCode;
  todayYmd: string;
  tomorrowYmd: string;
  /** The raw rows the roster maps were folded from — the roster route renders them. */
  shiftRows: ShiftRow[];
}

/** The two ET business dates the roster covers. */
export function rosterDates(now: Date): { todayYmd: string; tomorrowYmd: string } {
  const todayYmd = todayEasternYmd(now);
  return { todayYmd, tomorrowYmd: shiftYmd(todayYmd, 1) };
}

export async function loadEngineContext(
  centre: CentreCode,
  now: Date,
): Promise<LoadedEngineContext> {
  const { todayYmd, tomorrowYmd } = rosterDates(now);
  const [reps, rules, shiftRows, openVolumeByRepMonth] = await Promise.all([
    listReps(),
    listRules(),
    listShiftsForDates([todayYmd, tomorrowYmd]),
    loadOpenVolumeByRepMonth(),
  ]);
  const { shiftsToday, shiftsTomorrow } = rosterFromShiftRows(shiftRows, { todayYmd, tomorrowYmd });
  return {
    centre,
    todayYmd,
    tomorrowYmd,
    shiftRows,
    reps,
    rules,
    shiftsToday,
    shiftsTomorrow,
    openVolumeByRepMonth,
    now,
  };
}
