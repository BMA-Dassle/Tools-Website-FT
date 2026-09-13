/**
 * The job registry (brief §3.5): `HANDLERS` is pre-populated for EVERY kind in
 * `JOB_KINDS` (which lives in `core/types.ts`, "seed" included). PR1 implements
 * `noop` and `seed` for real; every other entry is `notImplemented`, which the
 * runner records as `status='failed'` with `{ok:false, error:"not implemented"}`
 * — never `done` (`runner.test.ts` pins it). A later PR replaces exactly its
 * own line.
 *
 * A handler returns an OUTCOME rather than throwing for expected failures, so
 * the runner can tell "park this" from "retry with backoff"; a throw is a
 * retry with the error message.
 */

import { runSeed } from "../core/seed";
import { JOB_KINDS, type JobKind, type JobRow } from "../core/types";
import { bmiMirrorBackfillHandler, bmiMirrorDeltaHandler } from "~/features/crm/bmi";
import { assignSweepHandler, sevenShiftsMirrorHandler } from "~/features/crm/rules";

export interface JobContext {
  job: JobRow;
  payload: Record<string, unknown>;
  /** The director who pressed "Run" — null on the cron. */
  actorEmail: string | null;
  now: Date;
}

export type JobOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string; /** stop retrying */ park?: boolean };

export type JobHandler = (ctx: JobContext) => Promise<JobOutcome>;

export const NOT_IMPLEMENTED_ERROR = "not implemented";

/**
 * A kind whose PR has not landed: an ordinary FAILURE (`status='failed'`,
 * retried with backoff, parked once `max_attempts` is spent) so nobody ever
 * mistakes it for a run. The `kind` argument is documentation for the registry
 * literal below — one line per kind, replaced by the PR that ships it.
 */
export function notImplemented(kind: JobKind): JobHandler {
  void kind;
  return async () => ({ ok: false, error: NOT_IMPLEMENTED_ERROR });
}

export const noopHandler: JobHandler = async ({ job, actorEmail, now }) => ({
  ok: true,
  result: {
    ok: true,
    actor_email: actorEmail ?? job.createdBy ?? "cron",
    ranAt: now.toISOString(),
  },
});

export const seedHandler: JobHandler = async () => ({ ok: true, result: await runSeed() });

export const HANDLERS: Record<JobKind, JobHandler> = {
  noop: noopHandler,
  seed: seedHandler,
  "mint-bmi-project": (ctx) => import("~/features/crm/leads").then((m) => m.runLeadBmiJob(ctx)),
  "assign-sweep": assignSweepHandler,
  "sevenshifts-mirror": sevenShiftsMirrorHandler,
  "bmi-mirror-delta": bmiMirrorDeltaHandler,
  "bmi-mirror-backfill": bmiMirrorBackfillHandler,
  "graph-renew": notImplemented("graph-renew"),
  "graph-fetch-message": notImplemented("graph-fetch-message"),
  "threecx-reconcile": notImplemented("threecx-reconcile"),
  "share-link-expire": notImplemented("share-link-expire"),
  "email-send-retry": notImplemented("email-send-retry"),
  "sms-send-retry": notImplemented("sms-send-retry"),
  "pandora-goals-sync": notImplemented("pandora-goals-sync"),
};

/** Kinds a director may run from the Statuses screen — everything registered. */
export const RUNNABLE_JOB_KINDS: readonly JobKind[] = JOB_KINDS;
