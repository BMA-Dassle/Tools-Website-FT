/**
 * `crm_audit` — who changed what (brief §3.8). Every mutating route writes one
 * row with the SIGNED-IN `actor_email` (R9); nothing here trusts a body field.
 *
 * `writeAudit` never throws: the mutation it describes has already happened,
 * and failing the request afterwards would make the director retry a change
 * that landed. A failed audit write is logged with the same fields instead.
 */

import { isDbConfigured, sql } from "@ft/db";

let schemaReady: Promise<void> | null = null;

export function ensureAuditSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_audit (
        id BIGSERIAL PRIMARY KEY,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_email TEXT NOT NULL,
        before JSONB,
        after JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`
      CREATE INDEX IF NOT EXISTS crm_audit_entity ON crm_audit (entity, entity_id, created_at DESC)
    `;
  })();
  return schemaReady;
}

export interface AuditEntry {
  entity: string;
  entityId: string;
  action: string;
  actorEmail: string;
  before?: unknown;
  after?: unknown;
}

export interface AuditRow {
  id: string;
  entity: string;
  entity_id: string;
  action: string;
  actor_email: string;
  before: unknown;
  after: unknown;
  created_at: string;
}

function jsonOrNull(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(v);
}

/** Record a mutation. Never throws. */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    await ensureAuditSchema();
    const q = sql();
    await q`
      INSERT INTO crm_audit (entity, entity_id, action, actor_email, before, after)
      VALUES (
        ${entry.entity}, ${entry.entityId}, ${entry.action}, ${entry.actorEmail},
        ${jsonOrNull(entry.before)}::jsonb, ${jsonOrNull(entry.after)}::jsonb
      )
    `;
  } catch (err) {
    console.error("[crm] audit write failed", {
      entity: entry.entity,
      entity_id: entry.entityId,
      action: entry.action,
      actor_email: entry.actorEmail,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Newest first, for one entity. */
export async function listAudit(entity: string, entityId: string, limit = 50): Promise<AuditRow[]> {
  if (!isDbConfigured()) return [];
  await ensureAuditSchema();
  const q = sql();
  return (await q`
    SELECT id::text AS id, entity, entity_id, action, actor_email, before, after, created_at::text
      FROM crm_audit
     WHERE entity = ${entity} AND entity_id = ${entityId}
     ORDER BY created_at DESC, id DESC
     LIMIT ${Math.min(Math.max(limit, 1), 200)}
  `) as AuditRow[];
}
