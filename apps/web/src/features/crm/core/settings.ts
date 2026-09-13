/**
 * `crm_settings` decoders — PURE. The Neon side is `./data/settings-db.ts`.
 *
 * Every decoder FAILS OPEN to the documented default (brief §3.8, R4): a
 * missing row, NULL, or an unparseable value is the default, never an error
 * and never "off". `bmi_writes` in particular is a kill switch — see
 * `bmiWritesFromSetting` in `./flags.ts`, re-exported here so the settings
 * object is assembled in one place.
 */

import { BMI_WRITES_DEFAULT, bmiWritesFromSetting } from "./flags";
import type { CrmSettingKey, CrmSettings, SweepSetting } from "./types";

export const SWEEP_DEFAULT: SweepSetting = Object.freeze({
  delayMinutes: 60,
  afterHours: "hold9am",
});

export const RESPONSE_TARGET_DEFAULT_MINUTES = 60;

export const CRM_SETTING_KEYS: readonly CrmSettingKey[] = [
  "bmi_writes",
  "sweep",
  "response_target_minutes",
];

export function isCrmSettingKey(value: unknown): value is CrmSettingKey {
  return typeof value === "string" && (CRM_SETTING_KEYS as readonly string[]).includes(value);
}

/** `{delayMinutes, afterHours}`; each field falls back on its own. */
export function sweepFromSetting(value: unknown): SweepSetting {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...SWEEP_DEFAULT };
  const v = value as { delayMinutes?: unknown; afterHours?: unknown };
  const delayMinutes =
    typeof v.delayMinutes === "number" && Number.isFinite(v.delayMinutes) && v.delayMinutes >= 0
      ? Math.round(v.delayMinutes)
      : SWEEP_DEFAULT.delayMinutes;
  const afterHours =
    v.afterHours === "assign" || v.afterHours === "hold9am"
      ? v.afterHours
      : SWEEP_DEFAULT.afterHours;
  return { delayMinutes, afterHours };
}

/** A positive integer number of minutes; anything else is the default. */
export function responseTargetFromSetting(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0
    ? Math.round(n)
    : RESPONSE_TARGET_DEFAULT_MINUTES;
}

/** The whole settings object from whatever rows exist (possibly none). */
export function settingsFromRows(
  rows: ReadonlyArray<{ key: string; value: unknown }>,
): CrmSettings {
  const byKey = new Map(rows.map((r) => [r.key, r.value] as const));
  return {
    bmiWrites: byKey.has("bmi_writes")
      ? bmiWritesFromSetting(byKey.get("bmi_writes"))
      : { ...BMI_WRITES_DEFAULT, offCentres: [] },
    sweep: sweepFromSetting(byKey.get("sweep")),
    responseTargetMinutes: responseTargetFromSetting(byKey.get("response_target_minutes")),
  };
}

/** The seed's default rows — what a fresh install stores explicitly. */
export const SETTINGS_SEED: ReadonlyArray<{ key: CrmSettingKey; value: unknown }> = [
  { key: "bmi_writes", value: { enabled: true, offCentres: [] } },
  { key: "sweep", value: { ...SWEEP_DEFAULT } },
  { key: "response_target_minutes", value: RESPONSE_TARGET_DEFAULT_MINUTES },
];
