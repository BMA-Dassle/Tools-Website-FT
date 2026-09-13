/**
 * THE MERGED TIMELINE (brief §4 B4: "timeline merge/sort").
 *
 * `service/lead-timeline.ts` (B3) reads ONE keyset page of `crm_activities`.
 * A deal's story, though, is told by more than that table: B5 folds in the
 * contract audit log and the Square payment timeline, B6 the BMI private-log
 * sections. Rather than have each of those PRs re-sort a growing list inside a
 * component, the merge lives here, once:
 *
 *   `mergeTimeline([activities, contractEvents, …])` → one list, newest first,
 *   deduped on `(external_kind, external_ref)` — the same identity the unique
 *   index on `crm_activities` uses, so a contract event that has ALREADY been
 *   mirrored into the activities table does not appear twice.
 *
 * B4 ships the merge with exactly one source (the activities page). A later PR
 * adds its source to the array at the call site and changes nothing here —
 * which is the point: the sort and the dedupe are written and tested once.
 *
 * Ordering is deterministic: `occurredAt` descending, then numeric id
 * descending, so two rows written in the same millisecond keep a stable order
 * rather than flapping between reads.
 */

import { isDbConfigured, sql } from "@ft/db";
import type { CrmActivity } from "../../core/types";
import type { TouchCounts } from "../contracts";
import { ensureActivitiesSchema } from "../data/activities-db";
import {
  decodeTimelineCursor,
  listLeadTimeline,
  mapActivityRow,
  type ActivityRowRaw,
  type TimelinePage,
} from "./lead-timeline";
import { countTouches, touchDayEt } from "./touches";

export { decodeTimelineCursor, listLeadTimeline, type TimelinePage };

/** `(externalKind, externalRef)` — null when the row has no external identity. */
export function externalIdentity(
  a: Pick<CrmActivity, "externalKind" | "externalRef">,
): string | null {
  if (!a.externalRef) return null;
  return `${a.externalKind ?? ""}|${a.externalRef}`;
}

function ordinal(a: CrmActivity): number {
  const t = Date.parse(a.occurredAt);
  return Number.isFinite(t) ? t : 0;
}

/** Newest first; ties broken by id descending. */
export function sortTimeline(items: readonly CrmActivity[]): CrmActivity[] {
  return [...items].sort((x, y) => {
    const d = ordinal(y) - ordinal(x);
    if (d !== 0) return d;
    const xi = Number(x.id);
    const yi = Number(y.id);
    if (Number.isFinite(xi) && Number.isFinite(yi) && xi !== yi) return yi - xi;
    return String(y.id).localeCompare(String(x.id));
  });
}

/**
 * One list from many sources. The FIRST source wins a duplicate: pass the
 * `crm_activities` page first and a mirrored contract event is dropped in
 * favour of the row we actually stored.
 */
export function mergeTimeline(sources: readonly (readonly CrmActivity[])[]): CrmActivity[] {
  const byExternal = new Set<string>();
  const byId = new Set<string>();
  const out: CrmActivity[] = [];
  for (const source of sources) {
    for (const a of source) {
      if (byId.has(a.id)) continue;
      const ext = externalIdentity(a);
      if (ext && byExternal.has(ext)) continue;
      byId.add(a.id);
      if (ext) byExternal.add(ext);
      out.push(a);
    }
  }
  return sortTimeline(out);
}

/**
 * What `GET /leads/[id]/activities` answers before the touch tally is added:
 * a keyset page of the lead's activities, merged (one source today).
 */
export function buildTimeline(
  page: TimelinePage,
  extraSources: readonly (readonly CrmActivity[])[] = [],
): TimelinePage {
  return {
    activities: mergeTimeline([page.activities, ...extraSources]),
    nextCursor: page.nextCursor,
  };
}

/**
 * Today's touches from an already-loaded page — no second query for the
 * common case, because the newest page always contains today's rows.
 */
export function touchesFrom(activities: readonly CrmActivity[], now: Date): TouchCounts {
  const today = touchDayEt(now);
  return countTouches(activities.filter((a) => touchDayEt(a.occurredAt) === today));
}

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * One row by id — what the POST route hands straight back so the client can
 * push it onto the timeline without a second round trip.
 */
export async function getActivity(id: string): Promise<CrmActivity | null> {
  if (!isDbConfigured()) return null;
  await ensureActivitiesSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT id::text AS id, lead_id::text AS lead_id, contact_id::text AS contact_id,
            rep_id::text AS rep_id, actor_email, kind, direction,
            ${ISO("occurred_at")} AS occurred_at, duration_seconds, outcome,
            subject, body, external_kind, external_ref, meta
       FROM crm_activities WHERE id = $1::bigint`,
    [id],
  )) as ActivityRowRaw[];
  return rows[0] ? mapActivityRow(rows[0]) : null;
}
