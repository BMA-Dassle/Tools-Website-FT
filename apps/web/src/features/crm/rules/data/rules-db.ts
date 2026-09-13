/**
 * `crm_assignment_rules` — the director-editable routing table (brief §3.8),
 * seeded R1..R7 from `crm-data.js:33-41`. `when_json` / `then_json` follow
 * `RuleWhen` / `RuleThen` in `core/types.ts`; the `then.hold` / `then.route`
 * values are rep SLUGS ('mkt', 'gs') as the prototype wrote them — the engine
 * (B2, `service/engine.ts`) resolves slug → `crm_reps.id` at evaluation time,
 * so a re-seeded roster never orphans a rule.
 *
 * B2 adds the readers and writers below the DDL (PR1 shipped the table and the
 * seed). Ids leave as STRINGS (`id::text`); the on-screen code "R3" is derived
 * from `position` by the client, never stored.
 */

import { isDbConfigured, sql } from "@ft/db";
import type { AssignmentRule, RuleKind, RuleThen, RuleWhen } from "../../core/types";

let schemaReady: Promise<void> | null = null;

export function ensureRulesSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_assignment_rules (
        id BIGSERIAL PRIMARY KEY,
        position INTEGER NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        kind TEXT NOT NULL CHECK (kind IN ('hold','route','avail','standard','fallback')),
        label TEXT NOT NULL,
        why TEXT,
        when_json JSONB NOT NULL DEFAULT '{}',
        then_json JSONB NOT NULL DEFAULT '{}',
        updated_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  })();
  return schemaReady;
}

export interface RuleSeed {
  position: number;
  kind: RuleKind;
  label: string;
  why: string;
  when: RuleWhen;
  then: RuleThen;
}

/**
 * Seed rows, inserted only when no rule with the same label exists — the table
 * has no natural key (positions move on reorder), so the label is the
 * idempotency handle. Returns how many were inserted.
 */
export async function seedRules(rows: readonly RuleSeed[]): Promise<number> {
  if (!isDbConfigured()) return 0;
  await ensureRulesSchema();
  const q = sql();
  let inserted = 0;
  for (const r of rows) {
    const out = (await q`
      INSERT INTO crm_assignment_rules (position, enabled, kind, label, why, when_json, then_json, updated_by)
      SELECT ${r.position}, TRUE, ${r.kind}, ${r.label}, ${r.why},
             ${JSON.stringify(r.when)}::jsonb, ${JSON.stringify(r.then)}::jsonb, 'seed'
      WHERE NOT EXISTS (SELECT 1 FROM crm_assignment_rules WHERE label = ${r.label})
      RETURNING id
    `) as { id: string }[];
    inserted += out.length;
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Rows (B2)
// ---------------------------------------------------------------------------

export interface RuleRowRaw {
  id: string;
  position: number;
  enabled: boolean;
  kind: string;
  label: string;
  why: string | null;
  when_json: unknown;
  then_json: unknown;
}

const KINDS = new Set<RuleKind>(["hold", "route", "avail", "standard", "fallback"]);

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function mapRuleRow(r: RuleRowRaw): AssignmentRule {
  return {
    id: String(r.id),
    position: typeof r.position === "number" ? r.position : Number(r.position) || 0,
    enabled: r.enabled !== false,
    kind: KINDS.has(r.kind as RuleKind) ? (r.kind as RuleKind) : "fallback",
    label: r.label,
    why: r.why ?? null,
    when: obj(r.when_json) as RuleWhen,
    then: obj(r.then_json) as RuleThen,
  };
}

const COLUMNS = `id::text AS id, position, enabled, kind, label, why, when_json, then_json`;

/** Every rule, enabled or not, in position order — what the engine and the screen read. */
export async function listRules(): Promise<AssignmentRule[]> {
  if (!isDbConfigured()) return [];
  await ensureRulesSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${COLUMNS} FROM crm_assignment_rules ORDER BY position ASC, id ASC`,
  )) as RuleRowRaw[];
  return rows.map(mapRuleRow);
}

export async function getRule(id: string): Promise<AssignmentRule | null> {
  if (!isDbConfigured()) return null;
  await ensureRulesSchema();
  const q = sql();
  const rows = (await q.query(`SELECT ${COLUMNS} FROM crm_assignment_rules WHERE id = $1::bigint`, [
    id,
  ])) as RuleRowRaw[];
  return rows[0] ? mapRuleRow(rows[0]) : null;
}

/** What the sheet sends: no `id` = a new rule, appended after the last position. */
export interface RuleInput {
  id?: string;
  label: string;
  kind: RuleKind;
  why?: string | null;
  when: RuleWhen;
  then: RuleThen;
  enabled?: boolean;
}

export async function insertRule(input: RuleInput, actorEmail: string): Promise<AssignmentRule> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureRulesSchema();
  const q = sql();
  const rows = (await q.query(
    `INSERT INTO crm_assignment_rules (position, enabled, kind, label, why, when_json, then_json, updated_by)
     VALUES (
       (SELECT COALESCE(MAX(position), 0) + 1 FROM crm_assignment_rules),
       COALESCE($1::boolean, TRUE), $2, $3, $4, $5::jsonb, $6::jsonb, $7
     )
     RETURNING ${COLUMNS}`,
    [
      input.enabled ?? null,
      input.kind,
      input.label,
      input.why ?? null,
      JSON.stringify(input.when ?? {}),
      JSON.stringify(input.then ?? {}),
      actorEmail,
    ],
  )) as RuleRowRaw[];
  return mapRuleRow(rows[0]);
}

/** Update label / kind / why / when / then; position and enabled are separate actions. */
export async function updateRule(
  id: string,
  input: Omit<RuleInput, "id" | "enabled">,
  actorEmail: string,
): Promise<AssignmentRule | null> {
  if (!isDbConfigured()) return null;
  await ensureRulesSchema();
  const q = sql();
  const rows = (await q.query(
    `UPDATE crm_assignment_rules
        SET kind = $2, label = $3, why = $4, when_json = $5::jsonb, then_json = $6::jsonb,
            updated_by = $7, updated_at = NOW()
      WHERE id = $1::bigint
      RETURNING ${COLUMNS}`,
    [
      id,
      input.kind,
      input.label,
      input.why ?? null,
      JSON.stringify(input.when ?? {}),
      JSON.stringify(input.then ?? {}),
      actorEmail,
    ],
  )) as RuleRowRaw[];
  return rows[0] ? mapRuleRow(rows[0]) : null;
}

/** The on/off switch on each rule row. */
export async function setRuleEnabled(
  id: string,
  enabled: boolean,
  actorEmail: string,
): Promise<AssignmentRule | null> {
  if (!isDbConfigured()) return null;
  await ensureRulesSchema();
  const q = sql();
  const rows = (await q.query(
    `UPDATE crm_assignment_rules
        SET enabled = $2, updated_by = $3, updated_at = NOW()
      WHERE id = $1::bigint
      RETURNING ${COLUMNS}`,
    [id, enabled, actorEmail],
  )) as RuleRowRaw[];
  return rows[0] ? mapRuleRow(rows[0]) : null;
}

/** Positions 1..n in the order given; ids not listed keep theirs. */
export async function reorderRules(ids: readonly string[], actorEmail: string): Promise<void> {
  if (!isDbConfigured() || ids.length === 0) return;
  await ensureRulesSchema();
  const q = sql();
  await q.query(
    `UPDATE crm_assignment_rules AS r
        SET position = o.pos, updated_by = $2, updated_at = NOW()
       FROM unnest($1::bigint[]) WITH ORDINALITY AS o(id, pos)
      WHERE r.id = o.id`,
    [ids, actorEmail],
  );
}
