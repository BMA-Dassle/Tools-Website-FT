/**
 * The `pandora-goals-sync` job handler — the one line C7 replaces in
 * `jobs/registry.ts`.
 *
 * It returns an OUTCOME rather than throwing for an expected failure (the
 * registry's contract): a rep with no BMI username is `ok:false` with the
 * reason, so the runner records `failed` with a sentence a director can read on
 * the Goals screen, and the backoff retries it after somebody fixes the roster.
 * A transport error throws out of `pushRepGoals` and is caught here for the
 * same treatment.
 *
 * Parking: a mirror that can never succeed as configured (no username, a year
 * Pandora refuses) is parked immediately rather than burning twenty attempts.
 */

import { listReps } from "~/features/crm/reps";
import type { JobContext, JobOutcome } from "~/features/crm/jobs";
import type { PandoraGoalsJobPayload } from "../contracts";
import { pushRepGoals } from "./pandora-goals";

export const pandoraGoalsSyncHandler = async (ctx: JobContext): Promise<JobOutcome> => {
  const payload = ctx.payload as Partial<PandoraGoalsJobPayload>;
  const repSlug = typeof payload.repSlug === "string" ? payload.repSlug : "";
  const year = typeof payload.year === "number" ? payload.year : 0;
  if (!repSlug || !year) {
    return { ok: false, error: "pandora-goals-sync needs {repSlug, year}", park: true };
  }

  const reps = await listReps({ includeInactive: true });
  const rep = reps.find((r) => r.slug === repSlug);
  if (!rep) return { ok: false, error: `no rep '${repSlug}'`, park: true };

  try {
    const summary = await pushRepGoals(rep, year, { now: () => ctx.now });
    if (!summary.ok) return { ok: false, error: summary.skipped ?? "mirror skipped", park: true };
    return { ok: true, result: summary };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};
