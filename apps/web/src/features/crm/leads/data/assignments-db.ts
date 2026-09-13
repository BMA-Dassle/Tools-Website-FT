/**
 * `crm_assignments` — every hand-off of a lead, with the rule trace that
 * decided it (brief §3.8). DDL is PR1's; B3 adds the writers and reader.
 *
 * `bmi_responsible_synced_at` is set only after `putProjectFields` VERIFIED
 * the Office `responsible` by re-read (R5); NULL means "not (yet) in BMI".
 */

import { isDbConfigured, sql } from "@ft/db";
import type { AssignmentReason, LeadAssignmentView, RuleTraceRowView } from "../contracts";
import { ensureLeadsSchema } from "./leads-db";
import { ISO } from "./sql";

let schemaReady: Promise<void> | null = null;

export function ensureAssignmentsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureLeadsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_assignments (
        id BIGSERIAL PRIMARY KEY,
        lead_id BIGINT NOT NULL REFERENCES crm_leads(id),
        from_rep_id BIGINT,
        to_rep_id BIGINT,
        actor_email TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('manual','auto','reassign','rule','release')),
        rule_id BIGINT,
        trace JSONB,
        note TEXT,
        bmi_responsible_synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_assignments_lead ON crm_assignments (lead_id, created_at DESC)`;
  })();
  return schemaReady;
}

export interface AssignmentRowRaw {
  id: string;
  lead_id: string;
  from_rep_id: string | null;
  to_rep_id: string | null;
  to_rep_name: string | null;
  to_rep_slug: string | null;
  actor_email: string;
  reason: string;
  rule_id: string | null;
  trace: unknown;
  note: string | null;
  bmi_responsible_synced_at: string | null;
  created_at: string;
}

const REASONS = new Set<AssignmentReason>(["manual", "auto", "reassign", "rule", "release"]);

function traceOf(value: unknown): RuleTraceRowView[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      ruleId: String(s.ruleId ?? ""),
      label: String(s.label ?? ""),
      hit: s.hit === true,
      ...(typeof s.note === "string" ? { note: s.note } : {}),
    }));
}

export function mapAssignmentRow(r: AssignmentRowRaw): LeadAssignmentView {
  return {
    id: String(r.id),
    leadId: String(r.lead_id),
    fromRepId: r.from_rep_id ? String(r.from_rep_id) : null,
    toRepId: r.to_rep_id ? String(r.to_rep_id) : null,
    toRepName: r.to_rep_name ?? null,
    toRepSlug: r.to_rep_slug ?? null,
    actorEmail: r.actor_email,
    reason: REASONS.has(r.reason as AssignmentReason) ? (r.reason as AssignmentReason) : "manual",
    ruleId: r.rule_id ? String(r.rule_id) : null,
    trace: traceOf(r.trace),
    note: r.note ?? null,
    bmiResponsibleSyncedAt: r.bmi_responsible_synced_at ?? null,
    createdAt: r.created_at,
  };
}

const COLUMNS = `
  x.id::text AS id, x.lead_id::text AS lead_id, x.from_rep_id::text AS from_rep_id, x.to_rep_id::text AS to_rep_id,
  r.display_name AS to_rep_name, r.slug AS to_rep_slug, x.actor_email, x.reason, x.rule_id::text AS rule_id,
  x.trace, x.note, ${ISO("x.bmi_responsible_synced_at")} AS bmi_responsible_synced_at, ${ISO("x.created_at")} AS created_at
`;

export interface NewAssignmentRow {
  leadId: string;
  fromRepId: string | null;
  toRepId: string | null;
  actorEmail: string;
  reason: AssignmentReason;
  /** `crm_assignment_rules.id` when a rule decided; the seed's "R6" labels are carried in the trace. */
  ruleId?: string | null;
  trace?: RuleTraceRowView[] | null;
  note?: string | null;
}

export async function insertAssignment(row: NewAssignmentRow): Promise<LeadAssignmentView> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureAssignmentsSchema();
  const q = sql();
  const inserted = (await q.query(
    `INSERT INTO crm_assignments (lead_id, from_rep_id, to_rep_id, actor_email, reason, rule_id, trace, note)
     VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5, $6::bigint, $7::jsonb, $8)
     RETURNING id::text AS id`,
    [
      row.leadId,
      row.fromRepId,
      row.toRepId,
      row.actorEmail,
      row.reason,
      row.ruleId && /^\d+$/.test(row.ruleId) ? row.ruleId : null,
      row.trace ? JSON.stringify(row.trace) : null,
      row.note ?? null,
    ],
  )) as { id: string }[];
  const rows = (await q.query(
    `SELECT ${COLUMNS} FROM crm_assignments x LEFT JOIN crm_reps r ON r.id = x.to_rep_id WHERE x.id = $1::bigint`,
    [inserted[0].id],
  )) as AssignmentRowRaw[];
  return mapAssignmentRow(rows[0]);
}

/** Newest first. */
export async function listAssignments(leadId: string, limit = 50): Promise<LeadAssignmentView[]> {
  if (!isDbConfigured()) return [];
  await ensureAssignmentsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${COLUMNS} FROM crm_assignments x LEFT JOIN crm_reps r ON r.id = x.to_rep_id
      WHERE x.lead_id = $1::bigint
      ORDER BY x.created_at DESC, x.id DESC
      LIMIT $2`,
    [leadId, Math.min(Math.max(limit, 1), 200)],
  )) as AssignmentRowRaw[];
  return rows.map(mapAssignmentRow);
}

/** The most recent hand-off, or null. */
export async function latestAssignment(leadId: string): Promise<LeadAssignmentView | null> {
  const rows = await listAssignments(leadId, 1);
  return rows[0] ?? null;
}

export async function markAssignmentResponsibleSynced(id: string, at: Date): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureAssignmentsSchema();
  const q = sql();
  await q`
    UPDATE crm_assignments SET bmi_responsible_synced_at = ${at.toISOString()}::timestamptz
     WHERE id = ${id}::bigint
  `;
}
