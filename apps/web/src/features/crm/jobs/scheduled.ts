/**
 * CRON SELF-ENQUEUE (brief §3.9, §5.7b).
 *
 * The CRM has ONE cron. Every job that is supposed to happen on a schedule is
 * therefore a row the cron puts in `crm_jobs` itself before it drains: the
 * drain runs whatever is due, and nothing needs a second Vercel cron entry.
 *
 * The whole thing rests on the idempotency key. Each scheduled kind owns a
 * helper that turns an instant into its BUCKET — `assign-sweep:2026-09-12T19`
 * is one ET hour, `sevenshifts-mirror:2026-09-12` is one ET day — and
 * `crm_jobs` has a unique index on the key with `ON CONFLICT DO NOTHING`
 * (`data/jobs-db.ts`). So the cron firing every two minutes enqueues an hourly
 * sweep once an hour and a daily mirror once a day; the 29 other ticks are a
 * no-op INSERT that returns the existing row with `created: false`.
 *
 * A kind that is not on this branch yet is simply absent from `SCHEDULED_KINDS`
 * — a later PR adds ONE line naming its own helper (see the TODO below).
 */

import { reconcileIdempotencyKey } from "~/features/crm/calls";
import { guestIntroBackstopKey } from "~/features/crm/leads/service/guest-intro-backstop";
import { mirrorIdempotencyKey, sweepIdempotencyKey } from "~/features/crm/rules";
import { enqueueDeltaTicks } from "~/features/crm/bmi/service/delta";
import { neonJobStore, type JobStore } from "./data/jobs-db";

/** `enqueueDeltaTicks` — one entry per Office tenant. */
export type DeltaTicks = (
  now: Date,
  deps: Pick<JobStore, "enqueue">,
) => Promise<Array<{ key: string; created: boolean }>>;
import type { JobKind } from "../core/types";

export interface ScheduledKind {
  kind: JobKind;
  /** The bucket this instant falls in — the row's idempotency key. */
  key: (now: Date) => string;
}

/**
 * Every scheduled kind whose bucket is ONE key per tick.
 *
 * `bmi-mirror-delta` deliberately is not here: its bucket is per TENANT
 * (`deltaIdempotencyKey(now, clientKey)` — one row per Office client key) and
 * it chains itself forward with a `{clientKey, chain: true}` payload. Bending
 * `ScheduledKind` around that would mean duplicating B1's bucket maths here
 * and becoming a second writer of its key, so `enqueueScheduled` calls B1's
 * own entry point as a separate step instead. See `enqueueDeltaTicks` below.
 */
export const SCHEDULED_KINDS: readonly ScheduledKind[] = [
  { kind: "assign-sweep", key: sweepIdempotencyKey },
  { kind: "sevenshifts-mirror", key: mirrorIdempotencyKey },
  // C3: one row per 5-minute bucket, so the 2-minute cron cannot stack reconciles.
  { kind: "threecx-reconcile", key: reconcileIdempotencyKey },
  // One row per ET hour: the deadline on a welcome held for a planner who
  // never arrived.
  { kind: "guest-intro-backstop", key: guestIntroBackstopKey },
];

export interface ScheduledEnqueue {
  kind: JobKind;
  idempotencyKey: string;
  /** false = this bucket was already enqueued by an earlier tick. */
  created: boolean;
  error?: string;
}

/**
 * Enqueue the current bucket of every scheduled kind. Never throws: a kind
 * whose INSERT fails is reported and the rest still go in, because the drain
 * that follows is the more important half of the tick.
 */
export async function enqueueScheduled(
  now: Date,
  store: Pick<JobStore, "enqueue"> = neonJobStore,
  kinds: readonly ScheduledKind[] = SCHEDULED_KINDS,
  /** Injected by its test; the live rail is B1's own `enqueueDeltaTicks`. */
  deltaTicks: DeltaTicks = enqueueDeltaTicks,
): Promise<ScheduledEnqueue[]> {
  const out: ScheduledEnqueue[] = [];
  for (const s of kinds) {
    const idempotencyKey = s.key(now);
    try {
      const { created } = await store.enqueue({
        kind: s.kind,
        idempotencyKey,
        payload: {},
        createdBy: "cron",
      });
      out.push({ kind: s.kind, idempotencyKey, created });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error("[crm-jobs] could not enqueue a scheduled job", {
        kind: s.kind,
        idempotency_key: idempotencyKey,
        error,
      });
      out.push({ kind: s.kind, idempotencyKey, created: false, error });
    }
  }

  // THE BMI MIRROR'S DELTA, one row per tenant.
  //
  // Nothing scheduled this before, so the incremental sync ran only when
  // somebody pressed Run by hand — and nobody ever had for Fort Myers. Naples
  // had delta rows; Fort Myers had none, so our copy of that centre went stale
  // the moment anything was booked, which is why H3447 (Edward Leslie,
  // Sullivan State Farm) was missing from the CRM entirely.
  //
  // The backfill cannot cover for it: the backfill reads `dayPlanner`, which
  // only returns projects that HAVE schedule blocks, so a New Lead can never
  // appear in one. The delta reads `liveReservations`, which does.
  //
  // Failures are swallowed the same way the loop above swallows them — the
  // drain that follows this is the more important half of the tick.
  try {
    for (const t of await deltaTicks(now, store))
      out.push({ kind: "bmi-mirror-delta", idempotencyKey: t.key, created: t.created });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[crm-jobs] could not enqueue the BMI delta ticks", { error });
    out.push({
      kind: "bmi-mirror-delta",
      idempotencyKey: "bmi-mirror-delta:(not enqueued)",
      created: false,
      error,
    });
  }
  return out;
}
