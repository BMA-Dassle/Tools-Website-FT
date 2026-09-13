/**
 * `crm_shifts` — who is on today, mirrored from 7shifts or set by hand (brief
 * §3.8). `starts_at` / `ends_at` are TIMESTAMPTZ: 7shifts sends a local offset
 * and Postgres parses it (portal F1.10). DDL in PR1; B2 adds the mirror
 * writers, the manual off-today override and the readers.
 *
 * TWO SOURCES, NEVER MIXED:
 *   '7shifts'  one row per 7shifts shift id; the mirror upserts by
 *              (rep_id, shift_date, source, seven_shifts_shift_id) and prunes
 *              rows whose shift vanished upstream. It never touches 'manual'.
 *   'manual'   ONE row per rep per date (the partial unique index below) that
 *              carries `off_today` / `off_reason` — the Rules screen's
 *              override, which works with no 7shifts token at all. Postgres
 *              treats NULLs as distinct in the table's UNIQUE constraint, so a
 *              manual row (no 7shifts id) needs its own conflict target.
 *
 * Dates are ET business dates (`shift_date`); the roster maps come out of
 * `service/availability.ts` `rosterFromShiftRows`.
 */

import { isDbConfigured, sql } from "@ft/db";
import { ensureRepsSchema } from "~/features/crm/reps";
import type { ShiftRow } from "../service/availability";

let schemaReady: Promise<void> | null = null;

export function ensureShiftsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureRepsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_shifts (
        id BIGSERIAL PRIMARY KEY,
        rep_id BIGINT NOT NULL REFERENCES crm_reps(id),
        shift_date DATE NOT NULL,
        starts_at TIMESTAMPTZ,
        ends_at TIMESTAMPTZ,
        source TEXT NOT NULL CHECK (source IN ('7shifts','manual')),
        seven_shifts_shift_id TEXT,
        location_id INTEGER,
        off_today BOOLEAN NOT NULL DEFAULT FALSE,
        off_reason TEXT,
        updated_by TEXT,
        synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (rep_id, shift_date, source, seven_shifts_shift_id)
      )
    `;
    // B2: one manual override row per rep per date (see the header).
    await q`
      CREATE UNIQUE INDEX IF NOT EXISTS crm_shifts_manual_one_per_day
        ON crm_shifts (rep_id, shift_date) WHERE source = 'manual'
    `;
  })();
  return schemaReady;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface ShiftRowRaw {
  id: string;
  rep_id: string;
  shift_date: string;
  starts_at: string | null;
  ends_at: string | null;
  source: string;
  seven_shifts_shift_id: string | null;
  location_id: number | null;
  off_today: boolean;
  off_reason: string | null;
  updated_by: string | null;
  synced_at: string | null;
}

export function mapShiftRow(r: ShiftRowRaw): ShiftRow {
  return {
    id: String(r.id),
    repId: String(r.rep_id),
    shiftDate: String(r.shift_date).slice(0, 10),
    startsAt: r.starts_at ?? null,
    endsAt: r.ends_at ?? null,
    source: r.source === "manual" ? "manual" : "7shifts",
    sevenShiftsShiftId: r.seven_shifts_shift_id ?? null,
    locationId: r.location_id ?? null,
    offToday: r.off_today === true,
    offReason: r.off_reason ?? null,
    updatedBy: r.updated_by ?? null,
    syncedAt: r.synced_at ?? null,
  };
}

const COLUMNS = `
  id::text AS id, rep_id::text AS rep_id, shift_date::text AS shift_date,
  starts_at::text AS starts_at, ends_at::text AS ends_at, source, seven_shifts_shift_id,
  location_id, off_today, off_reason, updated_by, synced_at::text AS synced_at
`;

/** Every row (both sources) for the given ET dates. */
export async function listShiftsForDates(dates: readonly string[]): Promise<ShiftRow[]> {
  if (!isDbConfigured() || dates.length === 0) return [];
  await ensureShiftsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${COLUMNS} FROM crm_shifts
      WHERE shift_date = ANY($1::date[])
      ORDER BY shift_date ASC, rep_id ASC, starts_at ASC NULLS LAST, id ASC`,
    [dates],
  )) as ShiftRowRaw[];
  return rows.map(mapShiftRow);
}

/** When the mirror last wrote anything, or null when it never has (the honest empty state). */
export async function lastSevenShiftsSyncAt(): Promise<string | null> {
  if (!isDbConfigured()) return null;
  await ensureShiftsSchema();
  const q = sql();
  const rows = (await q`
    SELECT MAX(synced_at)::text AS at FROM crm_shifts WHERE source = '7shifts'
  `) as { at: string | null }[];
  return rows[0]?.at ?? null;
}

// ---------------------------------------------------------------------------
// 7shifts mirror writers
// ---------------------------------------------------------------------------

export interface SevenShiftUpsert {
  repId: string;
  /** ET business date the shift belongs to. */
  shiftDate: string;
  /** ISO instants (the 7shifts strings carry their own offset and parse as-is). */
  startsAt: string;
  endsAt: string;
  sevenShiftsShiftId: string;
  locationId: number;
}

/** Insert or refresh mirrored rows. Returns how many rows were written. */
export async function upsertSevenShifts(rows: readonly SevenShiftUpsert[]): Promise<number> {
  if (!isDbConfigured() || rows.length === 0) return 0;
  await ensureShiftsSchema();
  const q = sql();
  let written = 0;
  for (const r of rows) {
    const out = (await q.query(
      `INSERT INTO crm_shifts (rep_id, shift_date, starts_at, ends_at, source, seven_shifts_shift_id, location_id, synced_at)
       VALUES ($1::bigint, $2::date, $3::timestamptz, $4::timestamptz, '7shifts', $5, $6, NOW())
       ON CONFLICT (rep_id, shift_date, source, seven_shifts_shift_id) DO UPDATE SET
         starts_at = EXCLUDED.starts_at,
         ends_at = EXCLUDED.ends_at,
         location_id = EXCLUDED.location_id,
         synced_at = NOW(),
         updated_at = NOW()
       RETURNING id`,
      [r.repId, r.shiftDate, r.startsAt, r.endsAt, r.sevenShiftsShiftId, r.locationId],
    )) as { id: string }[];
    written += out.length;
  }
  return written;
}

/** One mirrored row as it still exists upstream — the full identity, not just the shift id. */
export interface KeptShift {
  repId: string;
  shiftDate: string;
  sevenShiftsShiftId: string;
}

export interface PruneInput {
  locationId: number;
  dates: readonly string[];
  /**
   * The (rep, date, shift id) TRIPLES still present upstream for that location
   * and window — the same identity the upsert conflicts on.
   */
  keep: readonly KeptShift[];
}

/**
 * Drop mirrored rows the upstream no longer has. Manual rows are untouched by
 * construction (the `source` filter).
 *
 * Pruning by shift ID ALONE was a bug: when 7shifts moves an existing shift
 * from today to tomorrow it keeps its id, so the id was still in the keep list
 * and the old day's row survived beside the new one — the rep then read as on
 * shift on a day they were not working, and `onShiftNow` / `nextStart` could
 * pick someone who was off. The rep id matters for the same reason: a member
 * dropped from the Guest Services department leaves a bucket row whose shift
 * id is still live under their own rep row.
 */
export async function pruneSevenShifts(input: PruneInput): Promise<number> {
  if (!isDbConfigured() || input.dates.length === 0) return 0;
  await ensureShiftsSchema();
  const q = sql();
  const rows = (await q.query(
    `DELETE FROM crm_shifts s
      WHERE s.source = '7shifts'
        AND s.location_id = $1
        AND s.shift_date = ANY($2::date[])
        AND NOT EXISTS (
          SELECT 1
            FROM unnest($3::bigint[], $4::date[], $5::text[]) AS k(rep_id, shift_date, shift_id)
           WHERE k.rep_id = s.rep_id
             AND k.shift_date = s.shift_date
             AND k.shift_id = s.seven_shifts_shift_id
        )
      RETURNING id`,
    [
      input.locationId,
      input.dates,
      input.keep.map((k) => k.repId),
      input.keep.map((k) => k.shiftDate),
      input.keep.map((k) => k.sevenShiftsShiftId),
    ],
  )) as { id: string }[];
  return rows.length;
}

// ---------------------------------------------------------------------------
// Manual override
// ---------------------------------------------------------------------------

export interface OffTodayInput {
  repId: string;
  /** ET date; the Rules screen sends today. */
  date: string;
  off: boolean;
  /** Stored only when `off`; the prototype defaults it to "manual". */
  reason?: string | null;
  actorEmail: string;
}

/** Upsert the one manual row for (rep, date). Returns the row. */
export async function setOffToday(input: OffTodayInput): Promise<ShiftRow | null> {
  if (!isDbConfigured()) return null;
  await ensureShiftsSchema();
  const q = sql();
  const reason = input.off ? input.reason?.trim() || "manual" : null;
  const rows = (await q.query(
    `INSERT INTO crm_shifts (rep_id, shift_date, source, off_today, off_reason, updated_by)
     VALUES ($1::bigint, $2::date, 'manual', $3::boolean, $4, $5)
     ON CONFLICT (rep_id, shift_date) WHERE source = 'manual' DO UPDATE SET
       off_today = EXCLUDED.off_today,
       off_reason = EXCLUDED.off_reason,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING ${COLUMNS}`,
    [input.repId, input.date, input.off, reason, input.actorEmail],
  )) as ShiftRowRaw[];
  return rows[0] ? mapShiftRow(rows[0]) : null;
}
