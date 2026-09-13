/**
 * `crm_assignment_rules` — the director-editable routing table (brief §3.8),
 * seeded R1..R7 from `crm-data.js:33-41`. `when_json` / `then_json` follow
 * `RuleWhen` / `RuleThen` in `core/types.ts`; the `then.hold` / `then.route`
 * values are rep SLUGS ('mkt', 'gs') as the prototype wrote them — the engine
 * (B2) resolves slug → `crm_reps.id` at evaluation time, so a re-seeded roster
 * never orphans a rule.
 */

import { isDbConfigured, sql } from "@ft/db";
import type { RuleKind, RuleThen, RuleWhen } from "../../core/types";

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
