/**
 * The Goals editor's read and write (`GET`/`POST /api/admin/crm/goals`).
 *
 * ORDER OF OPERATIONS ON SAVE, and it is the whole point of this file:
 *   1. `upsertGoals` — Neon, committed. The owner's typing is safe from here
 *      on, whatever Pandora does.
 *   2. enqueue `pandora-goals-sync` per changed rep — a durable `crm_jobs` row,
 *      so the retry survives the request, the deploy and the browser tab.
 *   3. run those jobs INLINE, best effort, so the owner sees the answer now
 *      rather than in two minutes (and so a preview, where the cron never
 *      fires, mirrors at all — brief §1.7).
 * Step 3 failing is not an error the save reports as failure: the row is in
 * Neon and the job is queued. The response carries `mirrorError` and the screen
 * prints it beside the year. Nothing is swallowed and nothing is lost.
 */

import { listReps } from "~/features/crm/reps";
import { publicRep } from "~/features/crm/core/projections";
import { neonJobStore, runJobInline } from "~/features/crm/jobs";
import type { CrmRep, CrmUser, JobRow } from "~/features/crm/core/types";
import type {
  GoalCell,
  GoalMirrorState,
  GoalsPostBody,
  GoalsPostResponse,
  GoalsResponse,
  PandoraGoalsJobPayload,
} from "../contracts";
import { listGoalsForYear, upsertGoals } from "../data/goals-db";
import { monthlyRollup } from "../data/measure-db";
import { buildAttributionIndex } from "./attribution";
import { bucketOf } from "./buckets";
import { elapsedDays, monthWindow } from "./windows";
import { goalsSyncKey } from "./pandora-goals";

/** The prototype's banner: "Suggested = last year × 1.12". */
export const SUGGEST_FACTOR = 1.12;

/** The reps a goal may be set for — people and the Guest Services bucket. */
export function goalReps(reps: readonly CrmRep[]): CrmRep[] {
  return reps.filter((r) => r.active && (r.role === "rep" || r.role === "bucket"));
}

async function actualsByRepMonth(
  year: number,
  reps: readonly CrmRep[],
  now: Date,
): Promise<Map<string, number>> {
  const index = buildAttributionIndex(reps);
  const rows = await monthlyRollup(year, null);
  const out = new Map<string, number>();
  for (const row of rows) {
    if (bucketOf(row.stateName) !== "confirmed") continue;
    const match = index.match(row.clientKey, row.responsibleUserId, row.responsibleName);
    if (!match.rep) continue;
    const key = `${match.rep.id}:${row.month ?? 0}`;
    out.set(key, (out.get(key) ?? 0) + row.cents);
  }
  void now;
  return out;
}

export async function goalsGrid(
  user: CrmUser,
  year: number,
  now: Date = new Date(),
): Promise<Omit<GoalsResponse, "ok">> {
  const allReps = await listReps({ includeInactive: true });
  const reps = goalReps(allReps);
  const [rows, thisYear, lastYear, mirror] = await Promise.all([
    listGoalsForYear(year),
    actualsByRepMonth(year, allReps, now),
    actualsByRepMonth(year - 1, allReps, now),
    mirrorState(year),
  ]);

  const goalByKey = new Map<string, { goalCents: number; pandoraSyncedAt: string | null }>();
  for (const r of rows) {
    if (!r.repId) continue;
    const key = `${r.repId}:${r.month}`;
    const prev = goalByKey.get(key);
    goalByKey.set(key, {
      goalCents: (prev?.goalCents ?? 0) + r.goalCents,
      pandoraSyncedAt: prev?.pandoraSyncedAt ?? r.pandoraSyncedAt,
    });
  }

  const cells: GoalCell[] = [];
  for (const rep of reps) {
    for (let month = 1; month <= 12; month++) {
      const key = `${rep.id}:${month}`;
      const w = monthWindow(year, month, now);
      const started = elapsedDays(w.from, w.until, now) > 0;
      cells.push({
        repSlug: rep.slug,
        year,
        month,
        goalCents: goalByKey.get(key)?.goalCents ?? 0,
        lastYearCents: lastYear.get(key) ?? 0,
        actualCents: started ? (thisYear.get(key) ?? 0) : null,
        pandoraSyncedAt: goalByKey.get(key)?.pandoraSyncedAt ?? null,
      });
    }
  }

  return {
    year,
    reps: reps.map((r) => publicRep(r)!).filter(Boolean),
    cells,
    suggestFactor: SUGGEST_FACTOR,
    mirror,
    canEdit: user.role === "director",
  };
}

function parseMirrorPayload(job: JobRow): PandoraGoalsJobPayload | null {
  const p = job.payload as Partial<PandoraGoalsJobPayload> | undefined;
  if (!p || typeof p.repSlug !== "string" || typeof p.year !== "number") return null;
  return { repSlug: p.repSlug, year: p.year };
}

/** Every `pandora-goals-sync` row for a year, newest per rep — what the screen shows. */
export async function mirrorState(year: number): Promise<GoalMirrorState[]> {
  const jobs = await neonJobStore.list({ limit: 200 }).catch(() => [] as JobRow[]);
  const newest = new Map<string, GoalMirrorState>();
  for (const job of jobs) {
    if (job.kind !== "pandora-goals-sync") continue;
    const payload = parseMirrorPayload(job);
    if (!payload || payload.year !== year) continue;
    const seen = newest.get(payload.repSlug);
    if (seen && seen.updatedAt >= job.updatedAt) continue;
    newest.set(payload.repSlug, {
      repSlug: payload.repSlug,
      year,
      status: job.status,
      attempts: job.attempts,
      lastError: job.lastError,
      updatedAt: job.updatedAt,
    });
  }
  return [...newest.values()].sort((a, b) => a.repSlug.localeCompare(b.repSlug));
}

export async function saveGoals(
  user: CrmUser,
  body: GoalsPostBody,
  now: Date = new Date(),
): Promise<Omit<GoalsPostResponse, "ok">> {
  const allReps = await listReps({ includeInactive: true });
  const bySlug = new Map(goalReps(allReps).map((r) => [r.slug, r]));

  const writes: { repId: string; year: number; month: number; goalCents: number }[] = [];
  const touched = new Map<string, { rep: CrmRep; year: number }>();
  for (const g of body.goals) {
    const rep = bySlug.get(g.repSlug);
    if (!rep) continue;
    writes.push({ repId: rep.id, year: g.year, month: g.month, goalCents: g.goalCents });
    touched.set(`${rep.slug}:${g.year}`, { rep, year: g.year });
  }

  // 1. NEON FIRST. Everything below is a downstream sync.
  const changed = await upsertGoals(writes, user.email);

  const year = body.goals[0]?.year ?? now.getUTCFullYear();
  const queued: string[] = [];
  let mirrorError: string | null = null;

  if (changed > 0) {
    for (const { rep, year: goalYear } of touched.values()) {
      // 2. A DURABLE retry row, enqueued before anything is attempted.
      try {
        await neonJobStore.enqueue({
          kind: "pandora-goals-sync",
          idempotencyKey: goalsSyncKey(rep.slug, goalYear, now),
          payload: { repSlug: rep.slug, year: goalYear } satisfies PandoraGoalsJobPayload,
          createdBy: user.email,
        });
        queued.push(rep.slug);
      } catch (err) {
        mirrorError = err instanceof Error ? err.message : String(err);
        continue;
      }
      // 3. Best effort, right now — a preview never runs the cron.
      try {
        const run = await runJobInline({
          kind: "pandora-goals-sync",
          payload: { repSlug: rep.slug, year: goalYear },
          actorEmail: user.email,
        });
        const result = run.result as { ok?: boolean; error?: string; skipped?: string } | undefined;
        if (result && result.ok === false) {
          mirrorError = result.error ?? result.skipped ?? "Pandora mirror failed";
        } else if (result?.skipped) {
          mirrorError = result.skipped;
        }
      } catch (err) {
        mirrorError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const grid = await goalsGrid(user, year, now);
  return { year, cells: grid.cells, mirror: grid.mirror, queued, mirrorError };
}
