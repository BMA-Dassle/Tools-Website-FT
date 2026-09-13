/**
 * The CRM's ONE door to BMI Office reads (brief §3.2 "transport.ts: thin
 * re-exports of daily-events/data/bmi-office + fetchProjectRawIds").
 *
 * Every read here goes through `officeGet`, which parses with
 * `parseWithRawIds(text, OFFICE_ID_FIELDS)` — 17-digit ids arrive as STRINGS
 * (R1). Nothing in the CRM imports `lib/bmi-office-actions.ts`'s bare-`JSON.parse`
 * readers (`fetchProject`, `fetchPersonsByIds`, `fetchOfficePerson`).
 *
 * SESSION IDS. The mirror's bulk reads carry their own STABLE tag so BMI can
 * attribute the load and it never rides the guest-facing `events` session:
 * `crm-backfill-<clientKey>` for the backfill, `crm-delta-<clientKey>` for the
 * delta. Both go through `officeReadSessionId` — never a clock, never a UUID
 * (tasks/lessons.md 2026-08-25).
 *
 * CONCURRENCY. `officeAgent` caps the node-https client at 4 sockets; the fetch
 * client has no agent, so the ceiling is ours to keep: `mapWithConcurrency`
 * below, ≤ 2 for dayPlanner windows and ≤ 4 for project / person detail.
 */

import redis from "@/lib/redis";
import {
  OFFICE_ID_FIELDS,
  OfficeApiError,
  getMetadataLookups,
  officeGet,
} from "~/features/daily-events/data/bmi-office";
import type { MetadataLookups } from "~/features/daily-events/types";

export { OFFICE_ID_FIELDS, OfficeApiError, getMetadataLookups };
export type { MetadataLookups };

/** The backfill's session tag → `x-session-id: crm-backfill-<clientKey>`. */
export const CRM_BACKFILL_SESSION_TAG = "crm-backfill";
/** The delta's session tag → `x-session-id: crm-delta-<clientKey>`. */
export const CRM_DELTA_SESSION_TAG = "crm-delta";

export const DAYPLANNER_CONCURRENCY = 2;
export const DETAIL_CONCURRENCY = 4;

/**
 * Resource ids per dayPlanner call. Office sits behind IIS, whose default
 * query-string ceiling is 2 KB and whose answer past it is an HTML 404, not a
 * 414 — the very first live smoke of this PR hit exactly that with every
 * metadata resource in one URL (~2.9 KB). 40 ids × ~19 bytes stays well under.
 */
export const DAYPLANNER_RESOURCE_BATCH = 40;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const n = Math.max(1, size);
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

interface MetadataResource {
  id?: unknown;
  resourceId?: unknown;
  children?: MetadataResource[];
  subResources?: MetadataResource[];
  /** A resource GROUP nests its members here (Naples: 3 groups, 1 bare resource — probed 2026-09-13). */
  resources?: MetadataResource[];
}

interface MetadataResourcesBlob {
  resources?: MetadataResource[];
  subResources?: MetadataResource[];
  resourceGroups?: MetadataResource[];
  allResources?: MetadataResource[];
}

const RESOURCE_IDS_TTL_SECONDS = 7200;

function resourceIdsCacheKey(clientKey: string): string {
  return `crm:office:resource-ids:${clientKey}`;
}

/**
 * Every resource id in a blob: top level, children, sub-resources, groups AND
 * the members nested under each group's `resources` (where Naples keeps its
 * 30-odd lanes — without them the first live smoke saw 25 of 80 projects).
 */
export function collectResourceIds(blob: MetadataResourcesBlob): string[] {
  const out = new Set<string>();
  const add = (r: MetadataResource | undefined) => {
    if (!r) return;
    const id = r.id ?? r.resourceId;
    if (id !== null && id !== undefined && String(id) !== "") out.add(String(id));
    for (const c of r.children ?? []) add(c);
    for (const s of r.subResources ?? []) add(s);
    for (const m of r.resources ?? []) add(m);
  };
  for (const arr of [blob.resources, blob.subResources, blob.resourceGroups, blob.allResources]) {
    for (const r of arr ?? []) add(r);
  }
  return [...out];
}

/**
 * The tenant's OWN resource ids from its metadata blob (incl. resource groups),
 * Redis-cached 2 h. NOT `getMetadataLookups(ck).resourceNames` — that merges
 * the hard-coded Fort Myers RESOURCE_NAMES into every tenant, which is how the
 * first smoke sent 120 ids (most of them Fort Myers lanes) to Naples.
 */
export async function tenantResourceIds(
  clientKey: string,
  sessionTag: string = CRM_BACKFILL_SESSION_TAG,
): Promise<string[]> {
  const key = resourceIdsCacheKey(clientKey);
  try {
    const cached = await redis.get(key);
    if (cached) {
      const ids: unknown = JSON.parse(cached);
      if (Array.isArray(ids) && ids.every((x) => typeof x === "string") && ids.length > 0)
        return ids;
    }
  } catch {
    /* cache miss on a Redis outage — read live */
  }
  const blob = await officeGet<MetadataResourcesBlob>(clientKey, "metadata", sessionTag);
  const ids = collectResourceIds(blob);
  if (ids.length > 0) {
    try {
      await redis.setex(key, RESOURCE_IDS_TTL_SECONDS, JSON.stringify(ids));
    } catch {
      /* non-fatal */
    }
  }
  return ids;
}

/** `GET dayPlanner?resourceIds=…&from=YYYY-MM-DD&till=YYYY-MM-DD&showAll=true` under a tag. */
export function officeDayPlanner<T>(
  clientKey: string,
  resourceIds: readonly string[],
  fromYmd: string,
  tillYmd: string,
  sessionTag: string = CRM_BACKFILL_SESSION_TAG,
): Promise<T> {
  const resourceParams = resourceIds.map((id) => `resourceIds=${encodeURIComponent(id)}`).join("&");
  return officeGet<T>(
    clientKey,
    `dayPlanner?${resourceParams}&from=${fromYmd}&till=${tillYmd}&showAll=true`,
    sessionTag,
  );
}

/**
 * `GET liveReservations?from=…&until=…&projectStates=…&onlyCurrentUser=false`
 * under a tag. `from` / `until` are Office LOCAL wall-clock stamps
 * (`YYYY-MM-DDTHH:mm:ss`, no zone) — the endpoint filters by created/modified
 * date, not event date (portal T13), which is exactly what the delta wants.
 * Unlike `getLiveReservations` in daily-events this THROWS on failure: a delta
 * that silently saw nothing would advance the watermark past real changes.
 */
export function officeLiveReservations<T>(
  clientKey: string,
  fromLocal: string,
  untilLocal: string,
  stateIds: readonly string[],
  sessionTag: string = CRM_DELTA_SESSION_TAG,
): Promise<T> {
  const stateParams = stateIds.map((id) => `projectStates=${encodeURIComponent(id)}`).join("&");
  return officeGet<T>(
    clientKey,
    `liveReservations?from=${fromLocal}&until=${untilLocal}&${stateParams}&onlyCurrentUser=false`,
    sessionTag,
  );
}

/** `GET project/{id}` under a tag (the precision-safe detail read). */
export function officeProject<T>(
  clientKey: string,
  projectId: string,
  sessionTag: string = CRM_BACKFILL_SESSION_TAG,
): Promise<T> {
  return officeGet<T>(clientKey, `project/${encodeURIComponent(projectId)}`, sessionTag);
}

/** `GET person/{id}` under a tag. */
export function officePerson<T>(
  clientKey: string,
  personId: string,
  sessionTag: string = CRM_BACKFILL_SESSION_TAG,
): Promise<T> {
  return officeGet<T>(clientKey, `person/${encodeURIComponent(personId)}`, sessionTag);
}

/**
 * Map with a hard ceiling on in-flight calls, order preserved. A rejected item
 * becomes `{ok:false, error}` rather than aborting the batch — one 404 project
 * must not lose the other 199 in a window.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: string }>> {
  const out: Array<{ ok: true; value: R } | { ok: false; error: string }> = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = { ok: true, value: await fn(items[i] as T, i) };
      } catch (err) {
        out[i] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  await Promise.all(Array.from({ length: width }, () => worker()));
  return out;
}
