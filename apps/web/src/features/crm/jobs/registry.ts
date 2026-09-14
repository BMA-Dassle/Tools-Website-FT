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
import { shareLinkExpireHandler } from "~/features/crm/collateral";
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
  "graph-renew": (ctx) => import("~/features/crm/email").then((m) => m.runGraphRenewJob(ctx)),
  "graph-fetch-message": (ctx) =>
    import("~/features/crm/email").then((m) => m.runGraphFetchMessageJob(ctx)),
  "threecx-reconcile": (ctx) =>
    import("~/features/crm/calls").then((m) => m.runThreecxReconcileJob(ctx)),
  "share-link-expire": shareLinkExpireHandler,
  "email-send-retry": (ctx) =>
    import("~/features/crm/email").then((m) => m.runEmailSendRetryJob(ctx)),
  "sms-send-retry": (ctx) => import("~/features/crm/sms").then((m) => m.runSmsSendRetryJob(ctx)),
  // Lazily imported, like `mint-bmi-project`: the measure sub imports this
  // registry's `runJobInline` to mirror a save immediately, so a static import
  // here would close the cycle.
  "pandora-goals-sync": (ctx) =>
    import("~/features/crm/kpi").then((m) => m.pandoraGoalsSyncHandler(ctx)),
  "contract-cancel-verify": (ctx) =>
    import("~/features/crm/contracts").then((m) => m.runCancelVerifyJob(ctx.payload)),
  // Director-only by construction: `/api/admin/crm/jobs/run` is the only way
  // in and it is `{ director: true }`. A bad payload PARKS rather than retries
  // — "you did not give me a mailbox" will not become true on the fifth try.
  "seed-test-quote": (ctx) =>
    import("~/features/crm/contracts").then(async (m) => {
      try {
        return {
          ok: true as const,
          result: await m.runSeedTestQuoteJob(ctx.payload, ctx.actorEmail),
        };
      } catch (err) {
        if (err instanceof m.ContractActionError) {
          return { ok: false as const, error: err.code, park: true };
        }
        throw err;
      }
    }),
  // The deadline on a welcome held for a planner who never arrived. Lazily
  // imported like the other leads-sub handlers — the leads barrel is eager.
  "guest-intro-backstop": async () => {
    const m = await import("~/features/crm/leads");
    return { ok: true, result: await m.runGuestIntroBackstop() };
  },
};

/** Kinds a director may run from the Statuses screen — everything registered. */
export const RUNNABLE_JOB_KINDS: readonly JobKind[] = JOB_KINDS;
