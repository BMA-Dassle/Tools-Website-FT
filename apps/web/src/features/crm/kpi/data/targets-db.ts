/**
 * `crm_targets` — per-rep weekly activity targets, EFFECTIVE-DATED (brief §3.8).
 * DDL from PR1; C7 adds the effective-dated lookup and the director's upsert.
 *
 * Effective-dating is the point of the table: the sheet says "Applies from next
 * Monday", so raising Lori's call target today must not retrospectively mark
 * last week a failure. A lookup for a week takes the newest row whose
 * `effective_from` is on or before that week's MONDAY — never "the latest row",
 * which would rewrite history every time a director saved.
 *
 * A rep with no row at all gets `DEFAULT_TARGET`, and the screen says the
 * numbers are defaults rather than pretending a director set them.
 */

import { isDbConfigured, sql } from "@ft/db";
import { ensureRepsSchema } from "~/features/crm/reps";
import { RESPONSE_TARGET_DEFAULT_MINUTES } from "~/features/crm/core/settings";
import type { WeeklyTarget } from "../contracts";

let schemaReady: Promise<void> | null = null;

export function ensureTargetsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureRepsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_targets (
        id BIGSERIAL PRIMARY KEY,
        rep_id BIGINT NOT NULL REFERENCES crm_reps(id),
        effective_from DATE NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        texts INTEGER NOT NULL DEFAULT 0,
        emails INTEGER NOT NULL DEFAULT 0,
        reachouts INTEGER NOT NULL DEFAULT 0,
        response_target_minutes INTEGER NOT NULL DEFAULT 60,
        updated_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (rep_id, effective_from)
      )
    `;
  })();
  return schemaReady;
}

/**
 * D4 is still open (brief §5.8: "D4 weekly targets (C7 seeds prototype
 * numbers)"). These ARE the prototype's numbers for a full-time planner
 * (`crm-data.js:327` kelsea/lori), used for any rep the director has not set
 * yet; the Targets sheet writes a real row the moment anybody is edited.
 */
export const DEFAULT_TARGET: Readonly<WeeklyTarget> = Object.freeze({
  calls: 40,
  texts: 30,
  emails: 25,
  reachouts: 15,
  responseTargetMinutes: RESPONSE_TARGET_DEFAULT_MINUTES,
  effectiveFrom: null,
});

/** The Guest Services bucket answers a whole call centre — its own defaults. */
export const BUCKET_DEFAULT_TARGET: Readonly<WeeklyTarget> = Object.freeze({
  calls: 60,
  texts: 40,
  emails: 10,
  reachouts: 20,
  responseTargetMinutes: RESPONSE_TARGET_DEFAULT_MINUTES,
  effectiveFrom: null,
});

interface TargetRowRaw {
  rep_id: string;
  effective_from: string;
  calls: number;
  texts: number;
  emails: number;
  reachouts: number;
  response_target_minutes: number;
}

function int(v: number | string | null | undefined, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

/**
 * Each rep's target AS AT a given ET day (pass the week's Monday), keyed by
 * `crm_reps.id`. `DISTINCT ON` takes the newest effective row per rep in one
 * pass — no N+1, and no "latest row wins" history rewrite.
 */
export async function targetsAsOf(asOfYmd: string): Promise<Map<string, WeeklyTarget>> {
  if (!isDbConfigured()) return new Map();
  await ensureTargetsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT DISTINCT ON (t.rep_id)
            t.rep_id::text AS rep_id, t.effective_from::text AS effective_from,
            t.calls, t.texts, t.emails, t.reachouts, t.response_target_minutes
       FROM crm_targets t
      WHERE t.effective_from <= $1::date
      ORDER BY t.rep_id, t.effective_from DESC`,
    [asOfYmd],
  )) as TargetRowRaw[];
  return new Map(
    rows.map((r) => [
      String(r.rep_id),
      {
        calls: int(r.calls),
        texts: int(r.texts),
        emails: int(r.emails),
        reachouts: int(r.reachouts),
        responseTargetMinutes: int(r.response_target_minutes, RESPONSE_TARGET_DEFAULT_MINUTES),
        effectiveFrom: String(r.effective_from).slice(0, 10),
      } satisfies WeeklyTarget,
    ]),
  );
}

export interface TargetUpsert {
  repId: string;
  effectiveFrom: string;
  calls: number;
  texts: number;
  emails: number;
  reachouts: number;
  responseTargetMinutes: number;
}

export async function upsertTarget(input: TargetUpsert, actorEmail: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureTargetsSchema();
  const q = sql();
  await q.query(
    `INSERT INTO crm_targets
       (rep_id, effective_from, calls, texts, emails, reachouts, response_target_minutes, updated_by)
     VALUES ($1::bigint, $2::date, $3::int, $4::int, $5::int, $6::int, $7::int, $8)
     ON CONFLICT (rep_id, effective_from) DO UPDATE
       SET calls = EXCLUDED.calls,
           texts = EXCLUDED.texts,
           emails = EXCLUDED.emails,
           reachouts = EXCLUDED.reachouts,
           response_target_minutes = EXCLUDED.response_target_minutes,
           updated_by = EXCLUDED.updated_by`,
    [
      input.repId,
      input.effectiveFrom,
      input.calls,
      input.texts,
      input.emails,
      input.reachouts,
      input.responseTargetMinutes,
      actorEmail,
    ],
  );
}
