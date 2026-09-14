/**
 * `crm_goals` — monthly booked-revenue goals per rep (and optionally per
 * centre), mirroring the portal's `(rep, year, month, goal_cents)` shape (brief
 * §1.10). DDL from PR1; C7 adds the readers, the upsert and the Pandora mirror
 * bookkeeping.
 *
 * A GOAL IS PER REP PER MONTH, with `centre` NULL. That is what the Goals
 * editor writes, what the portal stored, and what Pandora's `/bmi/goals` can
 * hold — it is keyed by `(salesName, year, month)` with no centre at all
 * (brief C7). The column stays for a later per-centre breakdown; nothing writes
 * it yet, and `sumGoalsForYear` adds every centre row up so a future one cannot
 * silently vanish from the mirror.
 *
 * THE NULL-CENTRE UNIQUE TRAP: `UNIQUE (rep_id, centre, year, month)` does NOT
 * dedupe rows whose `centre` is NULL — Postgres treats NULLs as distinct in a
 * unique constraint, so `ON CONFLICT` would never fire and every save would
 * insert a second goal for the same month. The partial index below is the one
 * the upsert actually names, and it is what makes a re-save an UPDATE.
 */

import { isDbConfigured, sql } from "@ft/db";
import { ensureRepsSchema } from "~/features/crm/reps";

let schemaReady: Promise<void> | null = null;

export function ensureGoalsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureRepsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_goals (
        id BIGSERIAL PRIMARY KEY,
        rep_id BIGINT REFERENCES crm_reps(id),
        centre TEXT,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL,
        goal_cents BIGINT NOT NULL DEFAULT 0,
        updated_by TEXT,
        pandora_synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (rep_id, centre, year, month)
      )
    `;
    // The upsert target for the whole-rep goal the editor writes (centre NULL).
    await q`
      CREATE UNIQUE INDEX IF NOT EXISTS crm_goals_rep_year_month_all
        ON crm_goals (rep_id, year, month) WHERE centre IS NULL
    `;
  })();
  return schemaReady;
}

export interface GoalRow {
  repId: string | null;
  centre: string | null;
  year: number;
  month: number;
  goalCents: number;
  updatedBy: string | null;
  pandoraSyncedAt: string | null;
  updatedAt: string;
}

interface GoalRowRaw {
  rep_id: string | null;
  centre: string | null;
  year: number;
  month: number;
  goal_cents: string | number | null;
  updated_by: string | null;
  pandora_synced_at: string | null;
  updated_at: string;
}

function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export function mapGoalRow(r: GoalRowRaw): GoalRow {
  return {
    repId: r.rep_id === null || r.rep_id === undefined ? null : String(r.rep_id),
    centre: r.centre ?? null,
    year: num(r.year),
    month: num(r.month),
    goalCents: num(r.goal_cents),
    updatedBy: r.updated_by ?? null,
    pandoraSyncedAt: r.pandora_synced_at ?? null,
    updatedAt: r.updated_at,
  };
}

const COLUMNS = `g.rep_id::text AS rep_id, g.centre, g.year, g.month,
                 g.goal_cents::text AS goal_cents, g.updated_by,
                 g.pandora_synced_at::text AS pandora_synced_at, g.updated_at::text AS updated_at`;

/** Every goal row for a calendar year, every rep, every centre. */
export async function listGoalsForYear(year: number): Promise<GoalRow[]> {
  if (!isDbConfigured()) return [];
  await ensureGoalsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${COLUMNS} FROM crm_goals g WHERE g.year = $1::int ORDER BY g.month ASC`,
    [year],
  )) as GoalRowRaw[];
  return rows.map(mapGoalRow);
}

/** One rep's rows for a year — what the Pandora mirror sends. */
export async function listGoalsForRepYear(repId: string, year: number): Promise<GoalRow[]> {
  if (!isDbConfigured()) return [];
  await ensureGoalsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${COLUMNS}
       FROM crm_goals g
      WHERE g.rep_id = $1::bigint AND g.year = $2::int
      ORDER BY g.month ASC`,
    [repId, year],
  )) as GoalRowRaw[];
  return rows.map(mapGoalRow);
}

export interface GoalUpsert {
  repId: string;
  year: number;
  month: number;
  goalCents: number;
}

/**
 * Write the editor's grid. NEON FIRST AND ALWAYS (brief C7, CLAUDE.md "persist
 * at capture"): the owner's typing is committed here before any Pandora call is
 * even queued, so a failed mirror can never lose it.
 *
 * `pandora_synced_at` is CLEARED on every change — a goal that has moved is no
 * longer mirrored, and the Goals screen shows it as pending until the job says
 * otherwise. Rows whose value did not change are left alone (`WHERE … IS
 * DISTINCT FROM`), so re-saving an untouched grid does not un-sync the year.
 */
export async function upsertGoals(
  goals: readonly GoalUpsert[],
  actorEmail: string,
): Promise<number> {
  if (!isDbConfigured() || goals.length === 0) return 0;
  await ensureGoalsSchema();
  const q = sql();
  const rows = (await q.query(
    `INSERT INTO crm_goals (rep_id, centre, year, month, goal_cents, updated_by)
     SELECT x.rep_id::bigint, NULL, x.year::int, x.month::int, x.goal_cents::bigint, $5
       FROM UNNEST($1::text[], $2::int[], $3::int[], $4::bigint[])
            AS x(rep_id, year, month, goal_cents)
     ON CONFLICT (rep_id, year, month) WHERE centre IS NULL DO UPDATE
       SET goal_cents = EXCLUDED.goal_cents,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW(),
           pandora_synced_at = NULL
     WHERE crm_goals.goal_cents IS DISTINCT FROM EXCLUDED.goal_cents
     RETURNING rep_id::text AS rep_id`,
    [
      goals.map((g) => g.repId),
      goals.map((g) => g.year),
      goals.map((g) => g.month),
      goals.map((g) => g.goalCents),
      actorEmail,
    ],
  )) as { rep_id: string }[];
  return rows.length;
}

/** Σ of every centre row for a rep+year, keyed by month — what Pandora receives. */
export async function sumGoalsForYear(
  repId: string,
  year: number,
): Promise<{ month: number; goalCents: number }[]> {
  if (!isDbConfigured()) return [];
  await ensureGoalsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT g.month, SUM(g.goal_cents)::text AS goal_cents
       FROM crm_goals g
      WHERE g.rep_id = $1::bigint AND g.year = $2::int
      GROUP BY g.month
      ORDER BY g.month ASC`,
    [repId, year],
  )) as { month: number; goal_cents: string | number | null }[];
  return rows.map((r) => ({ month: num(r.month), goalCents: num(r.goal_cents) }));
}

/** Stamp a rep's year as mirrored, after Pandora accepted every month. */
export async function markGoalsSynced(repId: string, year: number, at: Date): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureGoalsSchema();
  const q = sql();
  await q.query(
    `UPDATE crm_goals SET pandora_synced_at = $3::timestamptz
      WHERE rep_id = $1::bigint AND year = $2::int`,
    [repId, year, at.toISOString()],
  );
}
