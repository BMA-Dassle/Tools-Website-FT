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

import { mirrorIdempotencyKey, sweepIdempotencyKey } from "~/features/crm/rules";
import { neonJobStore, type JobStore } from "./data/jobs-db";
import type { JobKind } from "../core/types";

export interface ScheduledKind {
  kind: JobKind;
  /** The bucket this instant falls in — the row's idempotency key. */
  key: (now: Date) => string;
}

/**
 * Every scheduled kind that existed on `feat/crm` when this branch was cut.
 *
 * TODO(release): `bmi-mirror-delta` landed with B1 AFTER this branch's rebase
 * point (`feat/crm` 224eaf875). It does NOT fit the one-key-per-tick shape
 * below — its bucket is per TENANT (`deltaIdempotencyKey(now, clientKey)`, one
 * row per Office client key) and it defers the row to the next 5-minute bucket
 * with a `{clientKey, chain: true}` payload. B1 already exports the exact
 * entry point a central scheduler wants: `enqueueDeltaTicks(now, { enqueue })`
 * from `~/features/crm/bmi` (`bmi/service/delta.ts`, "what a central scheduler
 * would call"). Wire it as its own step in `enqueueScheduled` rather than
 * bending `ScheduledKind` around it — duplicating the bucket maths here would
 * be a second writer of B1's key.
 *
 * C2 (`graph-renew:<day>`) and C3 (`threecx-reconcile:<minute>`) are the simple
 * shape and are one line each.
 */
export const SCHEDULED_KINDS: readonly ScheduledKind[] = [
  { kind: "assign-sweep", key: sweepIdempotencyKey },
  { kind: "sevenshifts-mirror", key: mirrorIdempotencyKey },
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
  return out;
}
