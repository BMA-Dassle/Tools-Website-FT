/**
 * One lead's timeline, newest first, keyset-paginated on
 * `(occurred_at, id)` (R10 — never OFFSET on crm_activities). B4's
 * `service/timeline.ts` merges this with contract and Square events; the deal
 * Overview in B3 renders it directly.
 */

import { isDbConfigured, sql } from "@ft/db";
import type { ActivityKind, CrmActivity, Direction } from "../../core/types";
import { ensureActivitiesSchema } from "../data/activities-db";

export interface ActivityRowRaw {
  id: string;
  lead_id: string | null;
  contact_id: string | null;
  rep_id: string | null;
  actor_email: string | null;
  kind: string;
  direction: string | null;
  occurred_at: string;
  duration_seconds: number | null;
  outcome: string | null;
  subject: string | null;
  body: string | null;
  external_kind: string | null;
  external_ref: string | null;
  meta: unknown;
}

export function mapActivityRow(r: ActivityRowRaw): CrmActivity {
  return {
    id: String(r.id),
    leadId: r.lead_id ? String(r.lead_id) : null,
    contactId: r.contact_id ? String(r.contact_id) : null,
    repId: r.rep_id ? String(r.rep_id) : null,
    actorEmail: r.actor_email ?? null,
    kind: r.kind as ActivityKind,
    direction: r.direction === "in" || r.direction === "out" ? (r.direction as Direction) : null,
    occurredAt: r.occurred_at,
    durationSeconds: r.duration_seconds ?? null,
    outcome: r.outcome ?? null,
    subject: r.subject ?? null,
    body: r.body ?? null,
    externalKind: r.external_kind ?? null,
    externalRef: r.external_ref ?? null,
    meta:
      r.meta && typeof r.meta === "object" && !Array.isArray(r.meta)
        ? (r.meta as Record<string, unknown>)
        : null,
  };
}

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const COLUMNS = `
  id::text AS id, lead_id::text AS lead_id, contact_id::text AS contact_id, rep_id::text AS rep_id,
  actor_email, kind, direction, ${ISO("occurred_at")} AS occurred_at, duration_seconds, outcome,
  subject, body, external_kind, external_ref, meta
`;

export interface TimelinePage {
  activities: CrmActivity[];
  /** `<occurredAtIso>|<id>` of the last row, for the next page; null at the end. */
  nextCursor: string | null;
}

export function decodeTimelineCursor(
  cursor: string | null | undefined,
): { occurredAt: string; id: string } | null {
  if (!cursor) return null;
  const bar = cursor.lastIndexOf("|");
  if (bar < 0) return null;
  const occurredAt = cursor.slice(0, bar);
  const id = cursor.slice(bar + 1);
  if (!/^\d{1,18}$/.test(id) || Number.isNaN(Date.parse(occurredAt))) return null;
  return { occurredAt, id };
}

export async function listLeadTimeline(
  leadId: string,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<TimelinePage> {
  if (!isDbConfigured()) return { activities: [], nextCursor: null };
  await ensureActivitiesSchema();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const cur = decodeTimelineCursor(opts.cursor);
  const params: unknown[] = [leadId, limit + 1];
  let keyset = "";
  if (cur) {
    params.push(cur.occurredAt, cur.id);
    keyset = ` AND (occurred_at, id) < ($3::timestamptz, $4::bigint)`;
  }
  const q = sql();
  const rows = (await q.query(
    `SELECT ${COLUMNS} FROM crm_activities
      WHERE lead_id = $1::bigint${keyset}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $2`,
    params,
  )) as ActivityRowRaw[];
  const page = rows.slice(0, limit).map(mapActivityRow);
  const last = page[page.length - 1];
  return {
    activities: page,
    nextCursor: rows.length > limit && last ? `${last.occurredAt}|${last.id}` : null,
  };
}
