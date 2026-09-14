/**
 * The BMI mirror DELTA (brief B1 "Mechanics"): `liveReservations` with
 * `from = last successful run − 10 min`, `until = now` — the endpoint filters
 * by created/modified stamp, which is exactly the point — then a full
 * detail + host read for every changed project at ≤ 4 concurrent, upserted
 * with `source: "delta"`. Never the `de:res:*` cache, never `listDailyEvents`.
 *
 * WATERMARK = the `window_until` of the last `ok` delta run for the tenant;
 * a run is `ok` only when EVERY changed project was mirrored, so a partial run
 * never advances it (the overlap makes a retry harmless). A window with more
 * changes than one run can read within its budget continues itself: the rest
 * of the ids ride a continuation job with the SAME explicit window, and the
 * run that finishes the list is the one that records `ok`.
 *
 * A PROJECT WHOSE DETAIL READ FAILED is stored from the live row so the mirror
 * is not blind to the change, and its id rides a RETRY job keyed
 * `<window key>:partial` — `liveReservations` filters by modified stamp, so
 * without that retry the project would never be looked at again until it
 * changed a second time. The key is a pure function of the window, so the
 * retry is enqueued once and `crm_jobs`' attempt cap parks it if Office keeps
 * refusing; the retry runs `chain:false` and never schedules a bucket of its
 * own.
 *
 * SCHEDULING (§3.9 "scheduled kinds are enqueued with fixed idempotency keys
 * `bmi-mirror-delta:<ck>:<5-min-bucket>`"): a complete run enqueues the next
 * bucket for its tenant, so one director-run `bmi-mirror-delta` seeds a chain
 * the cron drains every two minutes; `enqueueDeltaTicks` is the same call for
 * a central scheduler. Session tag `crm-delta`.
 */

import type { JobHandler, JobOutcome } from "~/features/crm/jobs";
import { OFFICE_CLIENT_KEYS } from "../../core/centres";
import { CRM_DELTA_SESSION_TAG, DETAIL_CONCURRENCY } from "../transport";
import {
  defaultMirrorDeps,
  mapWithConcurrency,
  type MirrorDeps,
  type OfficeMetadata,
} from "./deps";
import { mirrorOneProject, summarizeFailures, type DetailFailure } from "./mirror";
import { ONLINE_KIND_ID, liveReservationIds, liveReservationRow } from "./projection";
import {
  BACKFILL_TIME_BUDGET_MS,
  DELTA_KIND,
  deltaIdempotencyKey,
  deltaJobKey,
  deltaWindow,
  etWallClock,
  nextBucketStart,
} from "./windows";

export interface DeltaCursor {
  clientKey: string;
  /** ISO instants; present on a continuation (the window is then fixed). */
  fromIso: string | null;
  untilIso: string | null;
  /** The changed ids, once `liveReservations` has run; `offset` = already mirrored. */
  projectIds: string[] | null;
  offset: number;
  /** When true a complete run enqueues the next 5-minute bucket for the tenant. */
  chain: boolean;
}

export type DeltaParse = { ok: true; cursors: DeltaCursor[] } | { ok: false; error: string };

/** A payload with no `clientKey` runs every tenant in turn (the director's button). */
export function parseDeltaPayload(payload: Record<string, unknown>): DeltaParse {
  const ck = typeof payload.clientKey === "string" ? payload.clientKey.trim() : "";
  const keys = ck ? [ck] : [...OFFICE_CLIENT_KEYS];
  if (ck && !(OFFICE_CLIENT_KEYS as readonly string[]).includes(ck)) {
    return { ok: false, error: `unknown clientKey ${ck}` };
  }
  const fromIso = typeof payload.fromIso === "string" ? payload.fromIso : null;
  const untilIso = typeof payload.untilIso === "string" ? payload.untilIso : null;
  if (
    (fromIso && Number.isNaN(Date.parse(fromIso))) ||
    (untilIso && Number.isNaN(Date.parse(untilIso)))
  ) {
    return { ok: false, error: "payload.fromIso / untilIso must be ISO instants" };
  }
  const projectIds = Array.isArray(payload.projectIds)
    ? payload.projectIds.filter((x): x is string => typeof x === "string" && x !== "")
    : null;
  const offset =
    typeof payload.offset === "number" && Number.isInteger(payload.offset) && payload.offset >= 0
      ? payload.offset
      : 0;
  const chain = payload.chain !== false;
  return {
    ok: true,
    cursors: keys.map((clientKey) => ({ clientKey, fromIso, untilIso, projectIds, offset, chain })),
  };
}

export interface DeltaRunResult {
  ok: boolean;
  clientKey: string;
  window: { from: string; until: string; fromLocal: string; untilLocal: string };
  /** Null when this tenant had never had a successful delta (24 h look-back). */
  watermark: string | null;
  changed: number;
  offset: number;
  mirroredThisRun: number;
  inserted: number;
  updated: number;
  /** Changed projects whose detail read failed and were stored from the live row alone. */
  partial: number;
  /** The retry job enqueued for those ids, or null when there were none. */
  partialRetry: string | null;
  /** Changed ONLINE bookings (already mirrored as kind -10), refreshed from the live row without a detail read. */
  online: number;
  failed: DetailFailure[];
  runId: string;
  complete: boolean;
  next: string | null;
  nextCreated: boolean | null;
  elapsedMs: number;
}

export interface DeltaRunOptions {
  timeBudgetMs?: number;
  concurrency?: number;
}

/**
 * How far this run got, and whether that finishes the window.
 *
 * A SEPARATE FUNCTION BECAUSE THE ARITHMETIC RAN AWAY. On 2026-09-14 two
 * pending jobs sat in `crm_jobs` keyed
 * `bmi-mirror-delta:headpinzftmyers:…:oNaN` with `payload.offset` serialized
 * to null — `cursor.offset + processed` had evaluated to NaN. That is not a
 * cosmetic key: `NaN >= ids.length` is FALSE, so `complete` could never be
 * true, so every run enqueued another continuation, whose offset parsed back
 * to 0 and re-mirrored the same window from the start. A self-chaining job
 * that can never finish is a runaway against somebody else's web server.
 *
 * Neither input can be non-finite in today's code (`parseDeltaPayload` floors
 * `offset` to 0 and `processed` only ever takes `chunk.length`), so this is a
 * guard against a payload shape we have not thought of rather than a fix for a
 * line I can point at — the rows were written by an older deployment. It costs
 * one comparison and it converts an infinite loop into a completed run.
 */
export function deltaProgress(
  offset: number,
  processed: number,
  total: number,
): { done: number; complete: boolean } {
  const safe = (n: number) => (Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
  const done = safe(offset) + safe(processed);
  return { done, complete: done >= total };
}

export async function runDelta(
  cursor: DeltaCursor,
  deps: MirrorDeps,
  opts: DeltaRunOptions = {},
): Promise<DeltaRunResult> {
  const started = deps.now();
  const budget = opts.timeBudgetMs ?? BACKFILL_TIME_BUDGET_MS;
  const width = opts.concurrency ?? DETAIL_CONCURRENCY;
  const { clientKey } = cursor;

  const last = cursor.fromIso ? null : await deps.store.lastOkRun(clientKey, "delta");
  const watermark = last?.windowUntil ? new Date(last.windowUntil) : null;
  const window =
    cursor.fromIso && cursor.untilIso
      ? { from: new Date(cursor.fromIso), until: new Date(cursor.untilIso) }
      : deltaWindow(watermark && !Number.isNaN(watermark.getTime()) ? watermark : null, started);
  const fromLocal = etWallClock(window.from);
  const untilLocal = etWallClock(window.until);

  const runId = await deps.store.startRun({
    clientKey,
    kind: "delta",
    windowFrom: window.from.toISOString(),
    windowUntil: window.until.toISOString(),
  });

  let lookups: OfficeMetadata;
  let ids: string[];
  let liveById = new Map<string, ReturnType<typeof liveReservationRow>>();
  try {
    lookups = await deps.office.metadata(clientKey);
    if (cursor.projectIds) {
      ids = cursor.projectIds;
    } else {
      const live = await deps.office.liveReservations(
        clientKey,
        fromLocal,
        untilLocal,
        lookups.stateIds,
      );
      ids = liveReservationIds(live);
      liveById = new Map(
        live.map((lr) => [String(lr.id), liveReservationRow(lr, clientKey, lookups)]),
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.store.finishRun(runId, { rowsSeen: 0, rowsUpserted: 0, ok: false, error: message });
    throw err;
  }

  const failed: DetailFailure[] = [];
  const accountIds = new Set<string>();
  let inserted = 0;
  let updated = 0;
  let partial = 0;
  let online = 0;
  const partialIds: string[] = [];
  let processed = 0;
  const pending = ids.slice(cursor.offset);
  // Ids the mirror already knows as ONLINE bookings are refreshed from the
  // live row alone — no detail read for a kiosk booking that changed.
  const known = await deps.store.kinds(pending);

  for (let i = 0; i < pending.length; i += width) {
    if (i > 0 && deps.now().getTime() - started.getTime() > budget) break;
    const chunk = pending.slice(i, i + width);
    const results = await mapWithConcurrency(chunk, width, async (projectId) => {
      if (known.get(projectId) === ONLINE_KIND_ID) {
        const live = liveById.get(projectId) ?? null;
        if (live) {
          const { inserted: ins } = await deps.store.upsert(live, {
            accountId: null,
            contactId: null,
          });
          return { online: true as const, inserted: ins };
        }
      }
      return mirrorOneProject(
        clientKey,
        projectId,
        lookups,
        [],
        "delta",
        deps,
        CRM_DELTA_SESSION_TAG,
      );
    });
    for (let j = 0; j < results.length; j++) {
      const r = results[j]!;
      const projectId = chunk[j] as string;
      if (r.ok) {
        if (r.value.inserted) inserted++;
        else updated++;
        if ("online" in r.value) online++;
        else if (r.value.link.accountId) accountIds.add(r.value.link.accountId);
        continue;
      }
      // Detail failed: keep what the live row said so the mirror is not blind to the change.
      const fallback = liveById.get(projectId) ?? null;
      if (fallback) {
        try {
          const { inserted: ins } = await deps.store.upsert(fallback, {
            accountId: null,
            contactId: null,
          });
          if (ins) inserted++;
          else updated++;
          partial++;
          partialIds.push(projectId);
        } catch (err) {
          failed.push({
            projectId,
            error: `${r.error}; live row: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } else {
        failed.push({ projectId, error: r.error });
      }
    }
    processed += chunk.length;
  }

  try {
    await deps.linker.refresh([...accountIds]);
  } catch (err) {
    failed.push({
      projectId: "*",
      error: `lifetime roll-up: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // A project stored from the live row alone is NOT left behind: its id rides
  // a retry keyed by this window, enqueued once (a second partial run in the
  // same window hits the same key and creates nothing). `chain:false` so the
  // retry never schedules a bucket; `crm_jobs`' attempt cap parks it if the
  // detail read keeps failing.
  let partialRetry: string | null = null;
  if (partialIds.length > 0) {
    partialRetry = `${deltaJobKey(clientKey, window.until.toISOString())}:partial`;
    try {
      await deps.enqueue({
        kind: DELTA_KIND,
        idempotencyKey: partialRetry,
        payload: {
          clientKey,
          fromIso: window.from.toISOString(),
          untilIso: window.until.toISOString(),
          projectIds: partialIds,
          offset: 0,
          chain: false,
        },
        createdBy: "bmi-mirror-delta",
      });
    } catch (err) {
      failed.push({
        projectId: "*",
        error: `partial retry: ${err instanceof Error ? err.message : String(err)}`,
      });
      partialRetry = null;
    }
  }

  const { done, complete } = deltaProgress(cursor.offset, processed, ids.length);
  const ok = complete && failed.length === 0;
  // `error` also carries the partial-row note on an ok run: the watermark may
  // advance (the retry above owns those ids), but the row says which projects
  // it could not read in full.
  const notes = [
    complete ? null : `${done} of ${ids.length} mirrored; continued`,
    failed.length ? summarizeFailures(failed) : null,
    partialIds.length
      ? `${partialIds.length} stored from the live row only, retry ${partialRetry ?? "NOT enqueued"}: ${partialIds.join(", ")}`
      : null,
  ].filter((x): x is string => !!x);
  await deps.store.finishRun(runId, {
    rowsSeen: processed,
    rowsUpserted: inserted + updated,
    ok,
    error: notes.length ? notes.join(" · ") : null,
  });

  let next: string | null = null;
  let nextCreated: boolean | null = null;
  if (!complete) {
    const offset = done;
    next = `${deltaJobKey(clientKey, window.until.toISOString())}:o${offset}`;
    const { created } = await deps.enqueue({
      kind: DELTA_KIND,
      idempotencyKey: next,
      payload: {
        clientKey,
        fromIso: window.from.toISOString(),
        untilIso: window.until.toISOString(),
        projectIds: ids,
        offset,
        chain: cursor.chain,
      },
      createdBy: "bmi-mirror-delta",
    });
    nextCreated = created;
  } else if (cursor.chain) {
    const tick = await enqueueDeltaTick(clientKey, deps.now(), deps);
    next = tick.key;
    nextCreated = tick.created;
  }

  return {
    ok,
    clientKey,
    window: {
      from: window.from.toISOString(),
      until: window.until.toISOString(),
      fromLocal,
      untilLocal,
    },
    watermark: watermark ? watermark.toISOString() : null,
    changed: ids.length,
    offset: cursor.offset,
    mirroredThisRun: processed,
    inserted,
    updated,
    partial,
    partialRetry,
    online,
    failed,
    runId,
    complete,
    next,
    nextCreated,
    elapsedMs: deps.now().getTime() - started.getTime(),
  };
}

/** Enqueue the NEXT 5-minute bucket's delta for a tenant (idempotent by key). */
export async function enqueueDeltaTick(
  clientKey: string,
  now: Date,
  deps: Pick<MirrorDeps, "enqueue">,
): Promise<{ key: string; created: boolean }> {
  const runAt = nextBucketStart(now);
  const key = deltaIdempotencyKey(runAt, clientKey);
  const { created } = await deps.enqueue({
    kind: DELTA_KIND,
    idempotencyKey: key,
    payload: { clientKey, chain: true },
    runAt,
    createdBy: "bmi-mirror-delta",
  });
  return { key, created };
}

/** Every tenant's next tick — what a central scheduler would call. */
export async function enqueueDeltaTicks(
  now: Date,
  deps: Pick<MirrorDeps, "enqueue">,
): Promise<Array<{ key: string; created: boolean }>> {
  const out: Array<{ key: string; created: boolean }> = [];
  for (const ck of OFFICE_CLIENT_KEYS) out.push(await enqueueDeltaTick(ck, now, deps));
  return out;
}

export function makeDeltaHandler(deps: MirrorDeps = defaultMirrorDeps()): JobHandler {
  return async ({ payload }): Promise<JobOutcome> => {
    const parsed = parseDeltaPayload(payload);
    if (!parsed.ok) return { ok: false, error: parsed.error, park: true };
    const results: DeltaRunResult[] = [];
    for (const cursor of parsed.cursors) results.push(await runDelta(cursor, deps));
    return {
      ok: true,
      result: results.length === 1 ? results[0] : { ok: results.every((r) => r.ok), runs: results },
    };
  };
}

export const bmiMirrorDeltaHandler: JobHandler = (ctx) => makeDeltaHandler()(ctx);
