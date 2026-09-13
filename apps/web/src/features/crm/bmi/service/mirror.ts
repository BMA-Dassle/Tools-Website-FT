/**
 * The BMI mirror BACKFILL (brief B1 "Mechanics"): one 30-day dayPlanner window
 * per job run, chunked and resumable.
 *
 *   phase 1  dayPlanner?resourceIds=<every resource from metadata>&from&till&showAll=true
 *            (≤ 40 ids per call, ≤ 2 in flight) → the window's distinct
 *            projects and the schedule resources per id (FM/FT location split).
 *            Online bookings (kindId -10) are KEPT as stub rows bulk-upserted
 *            from the dayPlanner entry itself — never detail-read (Fort Myers
 *            lists ~3,000 of them a month against ~220 group events). The
 *            group-event ids go into the cursor so a continuation never
 *            repeats the call.
 *   phase 2  ≤ 80 group-event details per run at ≤ 4 concurrent (`GET
 *            project/{id}` + `GET person/{id}`), each projected, linked to an
 *            account + contact, and UPSERTED — a second pass inserts 0 rows
 *   then     re-enqueue: the same window with the offset advanced, or the next
 *            window, or nothing; every key from the cursor
 *            (`bmi-mirror-backfill:<ck>:<windowFrom>[:d<offset>]#<chain>`)
 *
 * Every run writes ONE `crm_bmi_sync_runs` row; `ok` is false when any detail
 * in the run failed (the failed ids are in the job result and the row's
 * error), and the chain still continues — a 404 project must not stall a
 * three-month backfill. A failure BEFORE any detail (auth, metadata, the
 * dayPlanner call) throws, so the runner retries the same job with backoff.
 *
 * Session tag `crm-backfill` (brief B1) — never the guest `events` session.
 */

import { easternRangeToUtc } from "../../core/dates";
import type { JobHandler, JobOutcome } from "~/features/crm/jobs";
import type { MirrorLink } from "../data/projects-mirror-db";
import {
  CRM_BACKFILL_SESSION_TAG,
  DAYPLANNER_CONCURRENCY,
  DAYPLANNER_RESOURCE_BATCH,
  DETAIL_CONCURRENCY,
  chunk,
} from "../transport";
import {
  defaultMirrorDeps,
  mapWithConcurrency,
  type MirrorDeps,
  type OfficeMetadata,
} from "./deps";
import {
  ONLINE_KIND_ID,
  dayPlannerEntries,
  dayPlannerPersons,
  dayPlannerProjects,
  dayPlannerStubRow,
  idString,
  projectDetail,
  type DayPlannerProjectRef,
  type MirrorRow,
  type OfficeDpPerson,
  type OfficeDpProject,
  type Projected,
} from "./projection";
import {
  BACKFILL_DETAIL_BATCH,
  BACKFILL_KIND,
  BACKFILL_TIME_BUDGET_MS,
  backfillJobKey,
  detailSlice,
  parseBackfillPayload,
  planAfterRun,
  type BackfillCursor,
} from "./windows";

export interface DetailFailure {
  projectId: string;
  error: string;
}

export interface BackfillRunResult {
  ok: boolean;
  clientKey: string;
  chain: string;
  window: { from: string; until: string };
  span: { from: string; until: string };
  /** Distinct projects the dayPlanner listed for the window (group events + online bookings). */
  projectsInWindow: number;
  /** The group events — the detail phase's list. */
  groupEvents: number;
  /** Where this run started and stopped in that list. */
  detailOffset: number;
  detailsThisRun: number;
  /** Group-event rows new to the mirror this run / already present. */
  inserted: number;
  updated: number;
  failed: DetailFailure[];
  /** Online bookings (kindId -10) stub-upserted from the dayPlanner entry (phase 1 only). */
  onlineBookings: number;
  onlineInserted: number;
  runId: string;
  /** The key of the job enqueued next, or null when the span is complete. */
  next: string | null;
  nextCreated: boolean | null;
  elapsedMs: number;
}

export interface BackfillRunOptions {
  detailBatch?: number;
  timeBudgetMs?: number;
  concurrency?: number;
}

/**
 * Read one project's detail + host and mirror it. Shared by the delta.
 * Returns the projected row (for the run's account list) or throws.
 */
export async function mirrorOneProject(
  clientKey: string,
  projectId: string,
  lookups: OfficeMetadata,
  scheduleResourceIds: readonly string[],
  source: "backfill" | "delta",
  deps: MirrorDeps,
  sessionTag: string,
): Promise<MirroredProject> {
  const detail = await deps.office.project(clientKey, projectId, sessionTag);
  const personId = idString(detail.personId) ?? idString(detail.contactPersonId);
  const person = personId ? await deps.office.person(clientKey, personId, sessionTag) : null;
  const projected = projectDetail(detail, person, {
    clientKey,
    source,
    lookups,
    scheduleResourceIds,
  });
  const link = await deps.linker.link(projected);
  const { inserted } = await deps.store.upsert(projected.row, link);
  return { projected, link, inserted };
}

export interface MirroredProject {
  projected: Projected;
  link: MirrorLink;
  inserted: boolean;
}

/** One run of the chain. Pure orchestration over `deps`. */
export async function runBackfillStep(
  cursorIn: BackfillCursor,
  deps: MirrorDeps,
  opts: BackfillRunOptions = {},
): Promise<BackfillRunResult> {
  const started = deps.now().getTime();
  const batch = opts.detailBatch ?? BACKFILL_DETAIL_BATCH;
  const budget = opts.timeBudgetMs ?? BACKFILL_TIME_BUDGET_MS;
  const width = opts.concurrency ?? DETAIL_CONCURRENCY;
  const { clientKey } = cursorIn;
  const { startUtc, endUtc } = easternRangeToUtc(cursorIn.windowFrom, cursorIn.windowUntil);

  const runId = await deps.store.startRun({
    clientKey,
    kind: "backfill",
    windowFrom: startUtc,
    windowUntil: endUtc,
  });

  let cursor = cursorIn;
  let lookups: OfficeMetadata;
  let onlineBookings = 0;
  let onlineInserted = 0;
  try {
    lookups = await deps.office.metadata(clientKey);
    if (!cursor.projectIds) {
      // One dayPlanner call per ≤ 40 resource ids (IIS query-string ceiling),
      // ≤ 2 in flight; the union is deduped by project id — a schedule-less
      // project comes back from every batch, a multi-resource one from several.
      const batches = chunk(lookups.resourceIds, DAYPLANNER_RESOURCE_BATCH);
      const pages = await mapWithConcurrency(batches, DAYPLANNER_CONCURRENCY, (ids) =>
        deps.office.dayPlanner(clientKey, ids, cursor.windowFrom, cursor.windowUntil),
      );
      const failedBatch = pages.find((p) => !p.ok);
      if (failedBatch && !failedBatch.ok) throw new Error(failedBatch.error);
      const dps = pages.flatMap((p) => (p.ok ? [p.value] : []));
      const refs = mergeDayPlannerRefs(dps.flatMap((dp) => dayPlannerProjects(dp)));

      // Online bookings (kindId -10) are KEPT — as stubs from the dayPlanner
      // entry, bulk-upserted now, never detail-read (see dayPlannerStubRow).
      const entries = new Map<string, OfficeDpProject>();
      const persons = new Map<string, OfficeDpPerson>();
      for (const dp of dps) {
        for (const [id, e] of dayPlannerEntries(dp)) if (!entries.has(id)) entries.set(id, e);
        for (const [id, person] of dayPlannerPersons(dp))
          if (!persons.has(id)) persons.set(id, person);
      }
      const online = refs.filter((r) => r.kindId === ONLINE_KIND_ID);
      const stubs = online
        .map((r) => {
          const e = entries.get(r.projectId);
          return e
            ? dayPlannerStubRow(e, persons, {
                clientKey,
                source: "backfill",
                lookups,
                scheduleResourceIds: r.scheduleResourceIds,
              })
            : null;
        })
        .filter((row): row is MirrorRow => row !== null);
      const bulk = await deps.store.upsertMany(stubs);
      onlineBookings = bulk.written;
      onlineInserted = bulk.inserted;

      const group = refs.filter((r) => r.kindId !== ONLINE_KIND_ID);
      cursor = {
        ...cursor,
        projectIds: group.map((r) => r.projectId),
        scheduleResources: Object.fromEntries(
          group.map((r) => [r.projectId, r.scheduleResourceIds]),
        ),
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.store.finishRun(runId, { rowsSeen: 0, rowsUpserted: 0, ok: false, error: message });
    throw err;
  }

  const ids = cursor.projectIds ?? [];
  const slice = detailSlice(cursor, batch);
  const failed: DetailFailure[] = [];
  const accountIds = new Set<string>();
  let inserted = 0;
  let updated = 0;
  let processed = 0;

  // Chunks of `width`, checking the budget between chunks — a run that stops
  // early hands the rest to a continuation job rather than dying at the deadline.
  for (let i = 0; i < slice.length; i += width) {
    if (i > 0 && deps.now().getTime() - started > budget) break;
    const chunk = slice.slice(i, i + width);
    const results = await mapWithConcurrency(chunk, width, (projectId) =>
      mirrorOneProject(
        clientKey,
        projectId,
        lookups,
        cursor.scheduleResources?.[projectId] ?? [],
        "backfill",
        deps,
        CRM_BACKFILL_SESSION_TAG,
      ),
    );
    results.forEach((r, j) => {
      const projectId = chunk[j] as string;
      if (r.ok) {
        if (r.value.inserted) inserted++;
        else updated++;
        if (r.value.link.accountId) accountIds.add(r.value.link.accountId);
      } else {
        failed.push({ projectId, error: r.error });
      }
    });
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

  const plan = planAfterRun(cursor, processed, ids.length);
  let next: string | null = null;
  let nextCreated: boolean | null = null;
  if (plan.kind !== "finished") {
    next = backfillJobKey(plan.cursor);
    const { created } = await deps.enqueue({
      kind: BACKFILL_KIND,
      idempotencyKey: next,
      payload: cursorToPayload(plan.cursor),
      createdBy: "bmi-mirror-backfill",
    });
    nextCreated = created;
  }

  const ok = failed.length === 0;
  await deps.store.finishRun(runId, {
    rowsSeen: processed + onlineBookings,
    rowsUpserted: inserted + updated + onlineBookings,
    ok,
    error: ok ? null : summarizeFailures(failed),
  });

  return {
    ok,
    clientKey,
    chain: cursor.chain,
    window: { from: cursor.windowFrom, until: cursor.windowUntil },
    span: { from: cursor.from, until: cursor.until },
    projectsInWindow: ids.length + onlineBookings,
    groupEvents: ids.length,
    detailOffset: cursor.detailOffset,
    detailsThisRun: processed,
    inserted,
    updated,
    failed,
    onlineBookings,
    onlineInserted,
    runId,
    next,
    nextCreated,
    elapsedMs: deps.now().getTime() - started,
  };
}

/** Union of several batches' refs: one entry per project, resource ids merged. */
export function mergeDayPlannerRefs(refs: readonly DayPlannerProjectRef[]): DayPlannerProjectRef[] {
  const byId = new Map<string, DayPlannerProjectRef>();
  for (const r of refs) {
    const prev = byId.get(r.projectId);
    if (!prev) {
      byId.set(r.projectId, { ...r, scheduleResourceIds: [...r.scheduleResourceIds] });
    } else {
      for (const id of r.scheduleResourceIds) {
        if (!prev.scheduleResourceIds.includes(id)) prev.scheduleResourceIds.push(id);
      }
      if (!prev.kindId && r.kindId) prev.kindId = r.kindId;
    }
  }
  return [...byId.values()];
}

export function cursorToPayload(c: BackfillCursor): Record<string, unknown> {
  return {
    clientKey: c.clientKey,
    from: c.from,
    until: c.until,
    windowFrom: c.windowFrom,
    windowUntil: c.windowUntil,
    detailOffset: c.detailOffset,
    projectIds: c.projectIds,
    scheduleResources: c.scheduleResources,
    chain: c.chain,
  };
}

export function summarizeFailures(failed: readonly DetailFailure[]): string {
  const head = failed
    .slice(0, 5)
    .map((f) => `${f.projectId}: ${f.error}`)
    .join(" · ");
  return failed.length > 5 ? `${head} · +${failed.length - 5} more` : head;
}

/** The registry entry: payload → cursor → one step. */
export function makeBackfillHandler(deps: MirrorDeps = defaultMirrorDeps()): JobHandler {
  return async ({ job, payload }): Promise<JobOutcome> => {
    const parsed = parseBackfillPayload(payload, job.id);
    if (!parsed.ok) return { ok: false, error: parsed.error, park: true };
    const result = await runBackfillStep(parsed.cursor, deps);
    return { ok: true, result };
  };
}

export const bmiMirrorBackfillHandler: JobHandler = (ctx) => makeBackfillHandler()(ctx);
