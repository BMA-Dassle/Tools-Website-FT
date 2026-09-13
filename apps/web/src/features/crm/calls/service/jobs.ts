/**
 * The `threecx-reconcile` job (brief §3.9, §4 C3).
 *
 * Reads the 3CX call log for the window since the newest call we hold and
 * upserts every external call in it, deduped on `CallHistoryId`. Registered on
 * the registry's `threecx-reconcile` line via a dynamic import of this sub's
 * barrel, so `jobs → calls → jobs` is never a static cycle (same shape as the
 * leads sub's `runLeadBmiJob`).
 *
 * Verdicts:
 *   - `ok` with the counts, including the case where the window was empty —
 *     a quiet hour is a successful run, not a failure;
 *   - `park` when 3CX is not configured at all, because no number of retries
 *     will conjure a client secret; the Calls screen already says so;
 *   - a retry with backoff for anything transient (the PBX's 60-second token,
 *     a 500, a timeout).
 *
 * `payload.from` / `payload.to` let a director re-run one window by hand from
 * `POST /api/admin/crm/jobs/run` — which is the only way it runs on a preview,
 * since `verifyCron` short-circuits there (§1.7).
 */

import type { JobContext, JobOutcome } from "~/features/crm/jobs";
import { defaultReconcileDeps, reconcileCalls, type ReconcileDeps } from "./journal";
import { threecxConfigured } from "./threecx";

export interface ReconcileJobDeps {
  reconcile: typeof reconcileCalls;
  deps: () => ReconcileDeps;
  configured: typeof threecxConfigured;
}

export function defaultReconcileJobDeps(): ReconcileJobDeps {
  return {
    reconcile: reconcileCalls,
    deps: () => defaultReconcileDeps,
    configured: threecxConfigured,
  };
}

/** An ISO instant from the payload, or undefined — never an Invalid Date. */
function instant(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function runThreecxReconcileJob(
  ctx: JobContext,
  deps: ReconcileJobDeps = defaultReconcileJobDeps(),
): Promise<JobOutcome> {
  if (!deps.configured()) {
    return { ok: false, error: "3cx_not_configured", park: true };
  }
  try {
    const result = await deps.reconcile(
      { now: ctx.now, from: instant(ctx.payload.from), to: instant(ctx.payload.to) },
      deps.deps(),
    );
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
