/**
 * `crm_status_bmi_map` — our status → ONE Office state per tenant (brief §3.8).
 *
 * Keyed by `client_key`, not centre: FT and HPFM share `headpinzftmyers`, so
 * one row covers both Fort Myers centres (see `core/centres.ts`). State ids
 * are TEXT and come only from Office metadata (`service/bmi-states.ts`) or a
 * director typing one in — never invented here.
 */

import { isDbConfigured, sql } from "@ft/db";
import type { OfficeClientKey, StatusBmiMapRow } from "../../core/types";
import { ensureStatusesSchema } from "./statuses-db";

let schemaReady: Promise<void> | null = null;

export function ensureStatusMapSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureStatusesSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_status_bmi_map (
        status_id TEXT NOT NULL REFERENCES crm_statuses(id),
        client_key TEXT NOT NULL,
        bmi_state_id TEXT NOT NULL,
        bmi_state_name TEXT NOT NULL,
        PRIMARY KEY (status_id, client_key)
      )
    `;
  })();
  return schemaReady;
}

interface MapRowRaw {
  status_id: string;
  client_key: string;
  bmi_state_id: string;
  bmi_state_name: string;
}

function mapRow(r: MapRowRaw): StatusBmiMapRow {
  return {
    statusId: r.status_id,
    clientKey: r.client_key as OfficeClientKey,
    bmiStateId: String(r.bmi_state_id),
    bmiStateName: r.bmi_state_name,
  };
}

export async function listStatusMap(): Promise<StatusBmiMapRow[]> {
  if (!isDbConfigured()) return [];
  await ensureStatusMapSchema();
  const q = sql();
  const rows = (await q`
    SELECT status_id, client_key, bmi_state_id, bmi_state_name
      FROM crm_status_bmi_map
     ORDER BY client_key ASC, status_id ASC
  `) as MapRowRaw[];
  return rows.map(mapRow);
}

/** The Office state for (status, tenant), or null when unmapped. */
export async function getStatusMapping(
  statusId: string,
  clientKey: string,
): Promise<StatusBmiMapRow | null> {
  if (!isDbConfigured()) return null;
  await ensureStatusMapSchema();
  const q = sql();
  const rows = (await q`
    SELECT status_id, client_key, bmi_state_id, bmi_state_name
      FROM crm_status_bmi_map
     WHERE status_id = ${statusId} AND client_key = ${clientKey}
  `) as MapRowRaw[];
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Insert or replace one mapping; returns the previous row (null = none). */
export async function upsertStatusMap(
  row: StatusBmiMapRow,
): Promise<{ before: StatusBmiMapRow | null; after: StatusBmiMapRow }> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureStatusMapSchema();
  const before = await getStatusMapping(row.statusId, row.clientKey);
  const q = sql();
  const rows = (await q`
    INSERT INTO crm_status_bmi_map (status_id, client_key, bmi_state_id, bmi_state_name)
    VALUES (${row.statusId}, ${row.clientKey}, ${row.bmiStateId}, ${row.bmiStateName})
    ON CONFLICT (status_id, client_key) DO UPDATE
      SET bmi_state_id = EXCLUDED.bmi_state_id, bmi_state_name = EXCLUDED.bmi_state_name
    RETURNING status_id, client_key, bmi_state_id, bmi_state_name
  `) as MapRowRaw[];
  return { before, after: mapRow(rows[0]) };
}

export async function deleteStatusMap(statusId: string, clientKey: string): Promise<boolean> {
  if (!isDbConfigured()) return false;
  await ensureStatusMapSchema();
  const q = sql();
  const rows = (await q`
    DELETE FROM crm_status_bmi_map
     WHERE status_id = ${statusId} AND client_key = ${clientKey}
     RETURNING status_id
  `) as { status_id: string }[];
  return rows.length > 0;
}
