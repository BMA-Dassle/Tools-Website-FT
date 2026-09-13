/**
 * `crm_settings.sevenshifts` — PURE decoding. The Neon side is
 * `./data/sevenshifts-settings-db.ts`.
 *
 * WHY THIS KEY EXISTS (owner, 2026-09-13, brief §5.7b). Guest Services is not a
 * 7shifts USER — it is a 7shifts DEPARTMENT: `635186`, "Call Center", at
 * HeadPinz Fort Myers (location 332160). The bucket counts as on shift whenever
 * anyone in that department is. A user row carries no department field, so the
 * only way to learn who is in it is `GET /users?status=active&department_id=…`
 * — which is why the id, not a name, is what we store.
 *
 * Kept as a LIST so a second centre's call centre can be added on the Rules
 * screen without a migration. `730648` (FastTrax) is deliberately NOT seeded:
 * the owner named one department, and the other holds a service account.
 * Every location also has a department literally called "Guest Services"
 * (484147 / 484174 / 730650) — a different thing; do not seed those either.
 *
 * Fail-open like every other decoder (§3.8): a missing row or an unparseable
 * value is the default. An explicitly stored EMPTY list is honoured, though —
 * that is a director saying "no department covers the bucket", not an absent
 * row. This is a configuration list, not a kill switch, so R4's "missing = ON"
 * polarity applies to the default, not to a deliberate clear.
 */

import type { SevenShiftsSetting } from "./contracts";

/** HeadPinz Fort Myers call centre — probed live 2026-09-13, named by the owner. */
export const GS_DEPARTMENT_ID = 635186;
export const GS_DEPARTMENT_NAME = "Call Center";

/** The `crm_settings` primary key this sub owns. */
export const SEVEN_SHIFTS_SETTING_KEY = "sevenshifts";

export const SEVEN_SHIFTS_SETTING_DEFAULT: SevenShiftsSetting = Object.freeze({
  gsDepartmentIds: [GS_DEPARTMENT_ID],
  gsDepartmentName: GS_DEPARTMENT_NAME,
});

/** Positive 32-bit ints, de-duplicated, order kept; null when the value is not a list. */
export function departmentIdsFrom(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const raw of value) {
    const n = typeof raw === "string" ? Number(raw) : raw;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > 2_147_483_647) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

export function sevenShiftsSettingFrom(value: unknown): SevenShiftsSetting {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...SEVEN_SHIFTS_SETTING_DEFAULT, gsDepartmentIds: [GS_DEPARTMENT_ID] };
  }
  const v = value as { gsDepartmentIds?: unknown; gsDepartmentName?: unknown };
  const ids = departmentIdsFrom(v.gsDepartmentIds);
  const name =
    typeof v.gsDepartmentName === "string" && v.gsDepartmentName.trim()
      ? v.gsDepartmentName.trim()
      : GS_DEPARTMENT_NAME;
  return { gsDepartmentIds: ids ?? [GS_DEPARTMENT_ID], gsDepartmentName: name };
}
