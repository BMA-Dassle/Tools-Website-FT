/**
 * READ-ONLY queries over `crm_leads` that the rules engine needs (brief B2
 * "standard rule = lowest Σ guests of OPEN leads for the party month" and the
 * sweep's "unassigned leads older than the delay setting").
 *
 * The leads sub (B3) owns every WRITER of `crm_leads`; this file only reads,
 * and only through the DDL PR1 already shipped (`ensureLeadsSchema` from the
 * sub's index — the one thing B2 may import from it). Held leads
 * (`held_for_rep_id` set, `assigned_rep_id` NULL) count toward nobody's
 * volume, exactly as the prototype's hold semantics say.
 */

import { isDbConfigured, sql } from "@ft/db";
import { ensureLeadsSchema } from "~/features/crm/leads";
import type { CentreCode, EventType, LeadSource } from "../../core/types";
import type { VolumeByRepMonth } from "../service/engine";

interface VolumeRowRaw {
  rep_id: string;
  month: string;
  guests: number | string;
  count: number | string;
}

/** repId → "YYYY-MM" → Σ guests / count, over OPEN, unarchived, assigned leads. */
export async function loadOpenVolumeByRepMonth(): Promise<VolumeByRepMonth> {
  if (!isDbConfigured()) return {};
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q`
    SELECT l.assigned_rep_id::text AS rep_id,
           to_char(l.event_date, 'YYYY-MM') AS month,
           COALESCE(SUM(l.guests), 0)::int AS guests,
           COUNT(*)::int AS count
      FROM crm_leads l
      JOIN crm_statuses s ON s.id = l.status_id
     WHERE s.kind = 'open'
       AND l.archived_at IS NULL
       AND l.assigned_rep_id IS NOT NULL
     GROUP BY 1, 2
  `) as VolumeRowRaw[];
  const out: VolumeByRepMonth = {};
  for (const r of rows) {
    const byMonth = (out[r.rep_id] ??= {});
    byMonth[r.month] = { guests: Number(r.guests) || 0, count: Number(r.count) || 0 };
  }
  return out;
}

/** An unassigned lead the sweep may decide on — the engine's input plus the ids to report. */
export interface SweepCandidate {
  id: string;
  publicId: string;
  centre: CentreCode;
  guests: number;
  type: EventType;
  eventDate: string;
  source: LeadSource;
  kids: boolean | undefined;
  createdAt: string;
}

interface CandidateRowRaw {
  id: string;
  public_id: string;
  centre: string;
  guests: number;
  event_type: string;
  event_date: string;
  source: string;
  kids: boolean | null;
  created_at: string;
}

/**
 * Open, unassigned, unheld, unarchived leads created at or before `olderThan`,
 * oldest first. `limit` is clamped to 200 (R10). `kids` is read from the
 * capture payload when the form said so; otherwise unknown.
 */
export async function listSweepCandidates(olderThan: Date, limit = 200): Promise<SweepCandidate[]> {
  if (!isDbConfigured()) return [];
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT l.id::text AS id, l.public_id, l.centre, l.guests, l.event_type,
            l.event_date::text AS event_date, l.source,
            CASE WHEN jsonb_typeof(l.capture_payload->'kids') = 'boolean'
                 THEN (l.capture_payload->>'kids')::boolean ELSE NULL END AS kids,
            l.created_at::text AS created_at
       FROM crm_leads l
       JOIN crm_statuses s ON s.id = l.status_id
      WHERE s.kind = 'open'
        AND l.archived_at IS NULL
        AND l.assigned_rep_id IS NULL
        AND l.held_for_rep_id IS NULL
        AND l.created_at <= $1::timestamptz
      ORDER BY l.created_at ASC, l.id ASC
      LIMIT $2`,
    [olderThan.toISOString(), Math.max(1, Math.min(limit, 200))],
  )) as CandidateRowRaw[];
  return rows.map((r) => ({
    id: String(r.id),
    publicId: r.public_id,
    centre: r.centre as CentreCode,
    guests: Number(r.guests) || 0,
    type: r.event_type as EventType,
    eventDate: String(r.event_date).slice(0, 10),
    source: r.source as LeadSource,
    kids: r.kids === null ? undefined : r.kids,
    createdAt: r.created_at,
  }));
}
