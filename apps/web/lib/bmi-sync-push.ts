/**
 * Vercel Queues transport for `bmi_sync_queue`.
 *
 * Every kind rides this, not just waivers. The four that were left on the
 * every-2-minutes cron all have someone waiting on them:
 *   - `add-membership`      the registration a guest needs to exist properly
 *   - `attach-project-person`  gates their race grid seat
 *   - `stamp-confirmation-state`  staff read it as "this party is checked in"
 *   - `repair-person-details`  until it runs, the person answers 500 on Pandora
 *     FOREVER and every consumer reads a 500 as "no waiver"
 *
 * The cron's floor was structural, not incidental: a closed barrier got a 30s
 * backoff AND then waited for the next tick, so "not synced yet" cost minutes for
 * something that lands in 10-32s. The waiver push measured 28s end to end.
 *
 * ── THE MESSAGE IS A POINTER ────────────────────────────────────────────────
 * `{ rowId }` and nothing else. The Neon row is written FIRST (house rule) and
 * holds the payload, the barrier and the give-up deadline, so a lost or expired
 * message costs a retry, never data. It also keeps every message inside one 4 KiB
 * billing chunk no matter how big the payload is — `push-waiver-signature` carries
 * a base64 PNG.
 */
import type { SyncQueueRow } from "@/lib/bmi-sync-queue";

/**
 * Topic is ENVIRONMENT-SCOPED, and this is not optional.
 *
 * Preview deployments share the PRODUCTION Neon database. A shared topic would let
 * a preview consumer claim, run and ACKNOWLEDGE a real guest's row that production
 * never sees — the same hazard that put a preview-written `persons-local` row into
 * the production table on 2026-08-13, with worse consequences because this one
 * writes to Pandora.
 *
 * The SDK also pins each message to the deployment that sent it by default, so this
 * is belt AND braces. The topics stay because they make the boundary legible in the
 * dashboard and survive any future change to pinning.
 */
export function syncTopic(): string {
  return process.env.VERCEL_ENV === "production" ? "bmi-sync" : "bmi-sync-preview";
}

/**
 * KILL SWITCH, not an opt-in gate (house rule: a merged feature is ON). Set
 * `BMI_SYNC_PUSH=false` and every row falls back to the cron, which stays wired.
 * Deliberately separate from `BMI_SYNC_QUEUE` so the push can be killed without
 * killing the waiter itself.
 */
export function syncPushEnabled(): boolean {
  return process.env.BMI_SYNC_PUSH !== "false";
}

/**
 * How long the queue OWNS a row.
 *
 * `listDueSyncRows` is a bare `status='pending' AND next_attempt_at <= now()` with
 * no claim — no `FOR UPDATE SKIP LOCKED`, no reaper. So without this, a cron tick
 * and a queue delivery would both run the same row and hit Pandora twice.
 *
 * Stamping `next_attempt_at = now() + LEASE` on a successful push makes the cron
 * unable to SEE the row while the queue has it, and makes the fallback automatic
 * rather than conditional: if the message is lost, the lease simply expires and the
 * cron reaps the row on its next tick.
 *
 * 180s comfortably covers the first delivery (10s) plus the early retry ladder,
 * and is re-stamped on every redelivery. It does NOT close the race completely — a
 * handler running longer than the lease could still overlap a tick — but handlers
 * carry idempotency keys and `GIVE_UP_MINUTES` bounds the whole thing, which is a
 * better trade than a schema migration on a live table.
 */
export const SYNC_LEASE_SECONDS = 180;

/**
 * First delivery delay. Matched to the MEASURED cloud→local window (10-32s), and
 * the entity is usually created several seconds before the row is enqueued.
 * Delivering sooner just burns a retry on a closed barrier.
 */
export const SYNC_PUSH_DELAY_SECONDS = 12;

/** Everything the consumer needs: which Neon row to run. */
export interface SyncPushMessage {
  rowId: number;
}

/**
 * Hand a row to Vercel Queues. Returns the message id, or null when the send did
 * not happen — callers MUST treat null as "leave it to the cron", never as "done".
 *
 * Errors are swallowed on purpose: the row is already durable in Neon, and a queue
 * outage must never fail the guest-facing write that enqueued it.
 */
export async function sendSyncPush(row: SyncQueueRow): Promise<string | null> {
  if (!syncPushEnabled()) return null;
  try {
    const { send } = await import("@vercel/queue");
    const { messageId } = await send(syncTopic(), { rowId: row.id } satisfies SyncPushMessage, {
      delaySeconds: SYNC_PUSH_DELAY_SECONDS,
      // Per ROW, not per kind-per-person: the row id is already unique, and
      // collapsing two legitimate rows would silently drop one.
      idempotencyKey: `bmi-sync-row-${row.id}`,
      // Long enough to outlast any barrier wait we would tolerate, far short of
      // the 7-day maximum. Past this, the row is a human's problem — the cron
      // still reports it as parked.
      retentionSeconds: 24 * 60 * 60,
    });
    return messageId ?? null;
  } catch (err) {
    // DuplicateMessageError is a SUCCESS in disguise: this row is already in flight.
    if (err instanceof Error && err.name === "DuplicateMessageError") return "duplicate";
    // No VERCEL_DEPLOYMENT_ID in local dev, so `send` refuses outright. That is the
    // correct degradation — the cron picks the row up — not a bug worth shouting at.
    console.warn(
      `[bmi-sync-push] send failed for row ${row.id} (${row.kind}) — leaving it to the cron:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
