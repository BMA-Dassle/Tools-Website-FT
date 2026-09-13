/**
 * `recordActivity` — the one writer of `crm_activities` rows from the leads
 * side (assign / system / bmi entries in B3; touches from C1-C3 later).
 *
 * `(external_kind, external_ref)` is unique, so a replayed webhook or a
 * retried job never doubles an entry — `ON CONFLICT DO NOTHING` returns null
 * for the duplicate and the caller treats it as already recorded.
 *
 * NEVER THROWS for the caller's sake once the primary mutation has landed:
 * an activity row is the diary, not the deed. A failure is logged with the
 * same fields and `null` is returned.
 */

import { isDbConfigured, sql } from "@ft/db";
import type { ActivityKind, Direction } from "../../core/types";
import { ensureActivitiesSchema } from "../data/activities-db";

export interface NewActivity {
  leadId: string | null;
  contactId?: string | null;
  repId?: string | null;
  actorEmail?: string | null;
  kind: ActivityKind;
  direction?: Direction | null;
  occurredAt?: Date | string | null;
  durationSeconds?: number | null;
  outcome?: string | null;
  subject?: string | null;
  body?: string | null;
  externalKind?: string | null;
  externalRef?: string | null;
  meta?: Record<string, unknown> | null;
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : v;
}

/** Insert one row; returns its id, or null when it was a duplicate or the write failed. */
export async function recordActivity(a: NewActivity): Promise<string | null> {
  if (!isDbConfigured()) return null;
  try {
    await ensureActivitiesSchema();
    const q = sql();
    const rows = (await q.query(
      `INSERT INTO crm_activities
         (lead_id, contact_id, rep_id, actor_email, kind, direction, occurred_at, duration_seconds,
          outcome, subject, body, external_kind, external_ref, meta)
       VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5, $6, COALESCE($7::timestamptz, NOW()), $8::int,
               $9, $10, $11, $12, $13, $14::jsonb)
       ON CONFLICT (external_kind, external_ref) WHERE external_ref IS NOT NULL DO NOTHING
       RETURNING id::text AS id`,
      [
        a.leadId,
        a.contactId ?? null,
        a.repId ?? null,
        a.actorEmail ?? null,
        a.kind,
        a.direction ?? null,
        iso(a.occurredAt),
        a.durationSeconds ?? null,
        a.outcome ?? null,
        a.subject ?? null,
        a.body ?? null,
        a.externalKind ?? null,
        a.externalRef ?? null,
        a.meta ? JSON.stringify(a.meta) : null,
      ],
    )) as { id: string }[];
    return rows[0] ? String(rows[0].id) : null;
  } catch (err) {
    console.error("[crm] activity write failed", {
      lead_id: a.leadId,
      kind: a.kind,
      actor_email: a.actorEmail ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
