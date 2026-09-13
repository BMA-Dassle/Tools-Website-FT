/**
 * The one `crm_settings` row this sub owns: `sevenshifts` (brief §5.7b).
 *
 * OWNERSHIP. `crm_settings` is core's table and PR1 owns its DDL, its key union
 * and the generic `/settings` route — so B2 does NOT widen `CrmSettingKey` or
 * add a branch to that route (§4 "shared files"). It reads and writes its own
 * key here, on the table core already created: `ensureSettingsSchema()` is
 * core's memoised promise, so this file issues no DDL of its own and cannot
 * race the core writer. The value shape is decoded by `../settings.ts`.
 */

import { isDbConfigured, sql } from "@ft/db";
import { ensureSettingsSchema } from "~/features/crm/core/data/settings-db";
import type { SevenShiftsSetting } from "../contracts";
import { SEVEN_SHIFTS_SETTING_KEY, sevenShiftsSettingFrom } from "../settings";

/** The stored departments, or the seeded default when there is no row. */
export async function getSevenShiftsSetting(): Promise<SevenShiftsSetting> {
  if (!isDbConfigured()) return sevenShiftsSettingFrom(undefined);
  await ensureSettingsSchema();
  const q = sql();
  const rows = (await q`
    SELECT value FROM crm_settings WHERE key = ${SEVEN_SHIFTS_SETTING_KEY}
  `) as { value: unknown }[];
  return sevenShiftsSettingFrom(rows[0]?.value);
}

/** Upsert the row; returns the value that was there before (undefined = no row). */
export async function putSevenShiftsSetting(
  value: SevenShiftsSetting,
  actorEmail: string,
): Promise<{ before: unknown }> {
  if (!isDbConfigured()) return { before: undefined };
  await ensureSettingsSchema();
  const q = sql();
  const rows = (await q`
    SELECT value FROM crm_settings WHERE key = ${SEVEN_SHIFTS_SETTING_KEY}
  `) as { value: unknown }[];
  await q`
    INSERT INTO crm_settings (key, value, updated_by, updated_at)
    VALUES (${SEVEN_SHIFTS_SETTING_KEY}, ${JSON.stringify(value)}::jsonb, ${actorEmail}, NOW())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
  `;
  return { before: rows[0]?.value };
}
