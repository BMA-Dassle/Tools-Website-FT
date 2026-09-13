/**
 * CRM kill switches.
 *
 * KILL SWITCHES ONLY — never opt-in gates (owner rule 2026-07-31; brief R4).
 * Every switch defaults ON via `!== "false"`, so a merged feature is a live
 * feature. Server-only (no `NEXT_PUBLIC_`): they gate route handlers and jobs,
 * not rendering.
 *
 * The six env switches:
 *   CRM_BMI_WRITES              every Office/Pandora WRITE from the CRM
 *   CRM_BMI_WRITES_OFF_CENTRES  comma list of Office clientKeys to pause alone
 *   CRM_SMS                     outbound texts
 *   CRM_EMAIL                   Graph send (falls back to SendGrid)
 *   CRM_CALLS                   3CX click-to-call
 *   CRM_AUTO_ASSIGN             the hourly assign sweep
 *
 * Plus ONE Neon-backed toggle a director flips from the Statuses screen:
 * `crm_settings.bmi_writes`. SAME POLARITY: no row, NULL, or an unparseable
 * value = ENABLED (`bmiWritesFromSetting`). The screen labels it "Pause BMI
 * writes", never "Enable".
 */

import type { BmiWritesSetting } from "./types";

export const CRM_FLAG_ENV = [
  "CRM_BMI_WRITES",
  "CRM_BMI_WRITES_OFF_CENTRES",
  "CRM_SMS",
  "CRM_EMAIL",
  "CRM_CALLS",
  "CRM_AUTO_ASSIGN",
] as const;

export type CrmFlagEnv = (typeof CRM_FLAG_ENV)[number];

function on(name: CrmFlagEnv): boolean {
  return process.env[name] !== "false";
}

function csv(name: CrmFlagEnv): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Every CRM write to Office / Pandora. */
export function crmBmiWritesEnabled(): boolean {
  return on("CRM_BMI_WRITES");
}

/** Office clientKeys whose writes are paused by env. Unset = none paused. */
export function crmBmiWritesOffCentres(): Set<string> {
  return new Set(csv("CRM_BMI_WRITES_OFF_CENTRES"));
}

export function crmSmsEnabled(): boolean {
  return on("CRM_SMS");
}

export function crmEmailEnabled(): boolean {
  return on("CRM_EMAIL");
}

export function crmCallsEnabled(): boolean {
  return on("CRM_CALLS");
}

export function crmAutoAssignEnabled(): boolean {
  return on("CRM_AUTO_ASSIGN");
}

/** What the setting means when nothing is stored: everything on. */
export const BMI_WRITES_DEFAULT: BmiWritesSetting = Object.freeze({
  enabled: true,
  offCentres: [],
});

/**
 * Decode the `crm_settings.bmi_writes` JSONB value.
 *
 * FAILS OPEN BY DESIGN: null, a missing row, a non-object, or a value whose
 * fields are the wrong type all decode to `{enabled: true, offCentres: []}`.
 * The only way to pause writes is to store `enabled: false` (or a clientKey in
 * `offCentres`) explicitly — a deleted row can never switch the CRM off.
 */
export function bmiWritesFromSetting(value: unknown): BmiWritesSetting {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...BMI_WRITES_DEFAULT, offCentres: [] };
  }
  const v = value as { enabled?: unknown; offCentres?: unknown };
  const enabled = v.enabled === false ? false : true;
  const offCentres = Array.isArray(v.offCentres)
    ? v.offCentres.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];
  return { enabled, offCentres };
}

/**
 * Env AND setting, combined: writes to `clientKey` are allowed only when the
 * env switch is on, the env pause list does not name the key, the director's
 * toggle is on, and the director's pause list does not name the key.
 */
export function bmiWritesAllowedFor(clientKey: string, setting: unknown): boolean {
  if (!crmBmiWritesEnabled()) return false;
  if (crmBmiWritesOffCentres().has(clientKey)) return false;
  const s = bmiWritesFromSetting(setting);
  if (!s.enabled) return false;
  return !s.offCentres.includes(clientKey);
}
