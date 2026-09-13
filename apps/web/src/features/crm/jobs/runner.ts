/**
 * The jobs runner (brief §3.9): drains due `crm_jobs` rows through
 * `HANDLERS[kind]` — lease 120 s, batch 50, 45 s deadline — and runs one job
 * inline for the director's "Run job" action (how previews are smoked, since
 * crons never run there).
 *
 * Verdicts: handler ok → `done`; handler not ok / throw → `failed` with backoff
 * (retried by the next drain) or `parked` once `max_attempts` is spent. A
 * `notImplemented` kind is never `done`.
 *
 * Everything takes a `RunnerDeps` so `runner.test.ts` drives it against an
 * in-memory store and a fake clock; the route handlers pass the defaults.
 */

import { randomUUID } from "node:crypto";
import type { JobKind, JobRow } from "../core/types";
import { neonJobStore, type JobStore } from "./data/jobs-db";
import { HANDLERS, NOT_IMPLEMENTED_ERROR, type JobHandler, type JobOutcome } from "./registry";

export interface RunnerDeps {
  store: JobStore;
  handlers: Record<JobKind, JobHandler>;
  now: () => Date;
}

export const DEFAULT_LEASE_SECONDS = 120;
export const DEFAULT_BATCH = 50;
export const DEFAULT_DEADLINE_MS = 45_000;

export function defaultRunnerDeps(): RunnerDeps {
  return { store: neonJobStore, handlers: HANDLERS, now: () => new Date() };
}

export interface RunResult {
  job: JobRow;
  outcome: JobOutcome;
}

/** Run ONE already-leased row through its handler and record the verdict. */
export async function runLeasedJob(
  job: JobRow,
  deps: RunnerDeps,
  actorEmail: string | null = null,
): Promise<RunResult> {
  const handler = deps.handlers[job.kind];
  let outcome: JobOutcome;
  if (!handler) {
    outcome = { ok: false, error: NOT_IMPLEMENTED_ERROR, park: true };
  } else {
    try {
      outcome = await handler({ job, payload: job.payload, actorEmail, now: deps.now() });
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const after = outcome.ok
    ? await deps.store.complete(job.id, outcome.result)
    : await deps.store.fail(job.id, outcome.error, { park: outcome.park });
  return { job: after ?? job, outcome };
}

export interface DrainOptions {
  batch?: number;
  leaseSeconds?: number;
  deadlineMs?: number;
}

export interface DrainOutcome {
  id: string;
  kind: JobKind;
  status: JobRow["status"];
  error?: string;
}

export interface DrainSummary {
  leased: number;
  ran: number;
  done: number;
  retry: number;
  parked: number;
  /** Leased but handed back untouched because the deadline arrived first. */
  deferred: number;
  outcomes: DrainOutcome[];
}

/** The cron body. Never throws for a single job's failure. */
export async function drainDueJobs(
  opts: DrainOptions = {},
  deps: RunnerDeps = defaultRunnerDeps(),
): Promise<DrainSummary> {
  const batch = opts.batch ?? DEFAULT_BATCH;
  const leaseSeconds = opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const started = deps.now().getTime();

  const leased = await deps.store.leaseDue(batch, leaseSeconds);
  const summary: DrainSummary = {
    leased: leased.length,
    ran: 0,
    done: 0,
    retry: 0,
    parked: 0,
    deferred: 0,
    outcomes: [],
  };

  for (const job of leased) {
    if (deps.now().getTime() - started > deadlineMs) {
      await deps.store.release(job.id);
      summary.deferred++;
      continue;
    }
    const { job: after, outcome } = await runLeasedJob(job, deps, null);
    summary.ran++;
    if (after.status === "done") summary.done++;
    else if (after.status === "parked") summary.parked++;
    else summary.retry++;
    summary.outcomes.push({
      id: after.id,
      kind: after.kind,
      status: after.status,
      ...(outcome.ok ? {} : { error: outcome.error }),
    });
  }
  return summary;
}

export interface RunInlineInput {
  kind: JobKind;
  payload?: Record<string, unknown>;
  actorEmail: string;
}

/**
 * The director's "Run job": a fresh row (its own idempotency key, so a second
 * press is a second run), leased and executed in-request. Returns the settled
 * row and the handler's result — a `notImplemented` kind comes back with
 * `job.status === "failed"` and `result.ok === false`, never a 500 and never
 * `done`. Manual rows keep the default `max_attempts`, so a transient failure
 * is retried by the cron like any other job.
 */
export async function runJobInline(
  input: RunInlineInput,
  deps: RunnerDeps = defaultRunnerDeps(),
): Promise<{ job: JobRow; result: unknown }> {
  const { job } = await deps.store.enqueue({
    kind: input.kind,
    idempotencyKey: `manual:${input.kind}:${randomUUID()}`,
    payload: input.payload ?? {},
    createdBy: input.actorEmail,
  });
  const leased = await deps.store.leaseById(job.id, DEFAULT_LEASE_SECONDS);
  if (!leased) throw new Error(`crm_jobs: could not lease job ${job.id}`);
  const { job: after, outcome } = await runLeasedJob(leased, deps, input.actorEmail);
  return { job: after, result: outcome.ok ? outcome.result : { ok: false, error: outcome.error } };
}
