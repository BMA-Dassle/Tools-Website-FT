/**
 * The two job handlers B2 owns in `jobs/registry.ts` (brief §3.5, §3.9):
 *
 *   sevenshifts-mirror  today + tomorrow per location → `crm_shifts`. Without a
 *                       token the job PARKS with `SEVEN_SHIFTS_API_TOKEN is not
 *                       set` — retrying twenty times would not conjure one, and
 *                       parked rows are what the director's "Needs attention"
 *                       tile lists. Payload: `{today?: "YYYY-MM-DD"}` to mirror
 *                       another day (defaults to ET today).
 *   assign-sweep        decisions for unassigned leads older than the delay
 *                       setting; `applied: 0`, reason `assign rail lands with
 *                       B3` until the follow-up stage wires B3's assign in.
 *                       Kill switch `CRM_AUTO_ASSIGN !== "false"` (R4).
 *
 * The handler type is imported as a TYPE only, so `rules` never loads the jobs
 * runtime (the registry imports us, not the other way round).
 */

import { CENTRE_LIST } from "~/features/crm/core/centres";
import { getCrmSettings } from "~/features/crm/core/data/settings-db";
import { shiftYmd, todayEasternYmd } from "~/features/crm/core/dates";
import { crmAutoAssignEnabled } from "~/features/crm/core/flags";
import type { JobHandler } from "~/features/crm/jobs";
import { listReps } from "~/features/crm/reps";
import { pruneSevenShifts, upsertSevenShifts } from "../data/shifts-db";
import { listSweepCandidates } from "../data/volume-db";
import { loadEngineContext } from "./context";
import { mirrorSevenShifts } from "./mirror";
import {
  SEVEN_SHIFTS_TOKEN_MISSING,
  SevenShiftsClient,
  isSevenShiftsConfigured,
} from "./sevenshifts";
import { runAssignSweep } from "./sweep";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const sevenShiftsMirrorHandler: JobHandler = async ({ payload, now }) => {
  if (!isSevenShiftsConfigured()) {
    return { ok: false, error: SEVEN_SHIFTS_TOKEN_MISSING, park: true };
  }
  const today =
    typeof payload.today === "string" && YMD.test(payload.today)
      ? payload.today
      : todayEasternYmd(now);
  const reps = await listReps();
  const summary = await mirrorSevenShifts({
    client: new SevenShiftsClient(),
    store: { upsertSevenShifts, pruneSevenShifts },
    reps,
    centres: CENTRE_LIST,
    todayYmd: today,
    tomorrowYmd: shiftYmd(today, 1),
  });
  const failed = summary.locations.filter((l) => l.error);
  if (failed.length === summary.locations.length && failed.length > 0) {
    return { ok: false, error: failed.map((l) => `${l.locationId}: ${l.error}`).join(" · ") };
  }
  return { ok: true, result: summary };
};

export const assignSweepHandler: JobHandler = async ({ now }) => {
  if (!crmAutoAssignEnabled()) {
    return { ok: true, result: { skipped: true, reason: 'CRM_AUTO_ASSIGN="false"', applied: 0 } };
  }
  const settings = await getCrmSettings();
  const result = await runAssignSweep({
    now,
    settings: settings.sweep,
    listCandidates: listSweepCandidates,
    loadContext: (at) => loadEngineContext("HPFM", at),
  });
  return { ok: true, result };
};
