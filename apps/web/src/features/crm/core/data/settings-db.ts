/**
 * `crm_settings` — the director's knobs (brief §3.8).
 *
 *   key                       value (JSONB)
 *   'bmi_writes'              {enabled, offCentres[]}   NO ROW = ON (kill switch, R4)
 *   'sweep'                   {delayMinutes, afterHours: 'hold9am'|'assign'}
 *   'response_target_minutes' number
 *
 * Decoding lives in `../settings.ts` (pure, tested); this file only moves rows.
 */

import { isDbConfigured, sql } from "@ft/db";
import { settingsFromRows } from "../settings";
import type { CrmSettingKey, CrmSettings } from "../types";

let schemaReady: Promise<void> | null = null;

export function ensureSettingsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  })();
  return schemaReady;
}

export interface SettingRow {
  key: string;
  value: unknown;
  updated_by: string | null;
  updated_at: string;
}

export async function listSettingRows(): Promise<SettingRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSettingsSchema();
  const q = sql();
  return (await q`SELECT key, value, updated_by, updated_at::text FROM crm_settings`) as SettingRow[];
}

/** Every setting, defaults filled in — safe with zero rows. */
export async function getCrmSettings(): Promise<CrmSettings> {
  return settingsFromRows(await listSettingRows());
}

/** One raw value, or undefined when there is no row (callers decode). */
export async function getSettingValue(key: CrmSettingKey): Promise<unknown> {
  if (!isDbConfigured()) return undefined;
  await ensureSettingsSchema();
  const q = sql();
  const rows = (await q`SELECT value FROM crm_settings WHERE key = ${key}`) as { value: unknown }[];
  return rows[0]?.value;
}

/** Upsert one setting; returns the previous raw value (undefined = no row). */
export async function putCrmSetting(
  key: CrmSettingKey,
  value: unknown,
  actorEmail: string,
): Promise<{ before: unknown }> {
  if (!isDbConfigured()) return { before: undefined };
  await ensureSettingsSchema();
  const q = sql();
  const before = await getSettingValue(key);
  await q`
    INSERT INTO crm_settings (key, value, updated_by, updated_at)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb, ${actorEmail}, NOW())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
  `;
  return { before };
}

/** Seed: insert the defaults that do not exist yet. Returns how many were inserted. */
export async function seedSettings(
  rows: ReadonlyArray<{ key: CrmSettingKey; value: unknown }>,
): Promise<number> {
  if (!isDbConfigured()) return 0;
  await ensureSettingsSchema();
  const q = sql();
  let inserted = 0;
  for (const r of rows) {
    const out = (await q`
      INSERT INTO crm_settings (key, value, updated_by)
      VALUES (${r.key}, ${JSON.stringify(r.value)}::jsonb, 'seed')
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    `) as { key: string }[];
    inserted += out.length;
  }
  return inserted;
}
