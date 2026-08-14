/**
 * Vercel Queues consumer for `bmi_sync_queue` — every kind, one route.
 *
 * The message is just `{ rowId }`; everything else is read from Neon, which stays
 * the source of truth. Dispatch goes through the existing `SYNC_HANDLERS` registry,
 * so a new kind needs no work here.
 *
 * ── WHY A FACTORY ───────────────────────────────────────────────────────────
 * The topic is environment-scoped and Vercel binds EXACTLY ONE `queue/v2beta`
 * trigger per function — two entries under one route is a build error that fires in
 * `onBuildComplete`, after a clean compile and all 350 static pages, and produces no
 * deployment at all. So each topic gets its own route file and both call this.
 *
 * ── THE ORDER OF OPERATIONS IS THE CRON'S, DELIBERATELY ─────────────────────
 *   1. barrier probe (reads only, via the SHARED `probeBarrier`)
 *   2. closed  → redeliver WITHOUT burning an attempt (waiting on Fast WSync is not
 *                a failed attempt; the give-up DEADLINE is what bounds it)
 *      error   → redeliver AND burn an attempt (we could not even ask)
 *      open    → run the handler
 *   3. handler verdict → done / retry / park
 *
 * What this transport adds over the cron is only latency: a closed barrier costs
 * ~10s here instead of a 30s backoff plus the wait for the next 2-minute tick. The
 * visibility timeout also gives us the claim and the stale-row reaper that
 * `bmi_sync_queue` has never had.
 */
import { handleCallback } from "@vercel/queue";
import {
  getSyncRowById,
  leaseSyncRow,
  markSyncDone,
  markSyncRetry,
  parkSyncRow,
} from "@/lib/bmi-sync-queue";
import { probeBarrier } from "@/lib/bmi-sync-probe";
import { SYNC_LEASE_SECONDS, type SyncPushMessage } from "@/lib/bmi-sync-push";
import { SYNC_HANDLERS } from "@/lib/bmi-sync-handlers";

/**
 * Redelivery delay while we wait for BMI cloud→local sync.
 *
 * Flat and short at first because the thing we are waiting for lands in 10-32s —
 * exponential backoff would turn a 12-second wait into a two-minute one for no
 * reason. It only stretches once we are clearly past the normal window.
 */
function retrySeconds(deliveryCount: number): number {
  if (deliveryCount <= 4) return 10;
  if (deliveryCount <= 10) return 30;
  return 120;
}

/**
 * Stop asking, and HAND THE ROW BACK.
 *
 * At ~20 deliveries we are well past any normal sync window. Unlike the waiver
 * consumer — which has no durable queue row to fall back on — this can simply
 * release the lease and let the cron own the row again, where `GIVE_UP_MINUTES` and
 * the parked-row report already handle a genuine fault. So giving up here costs
 * latency, never the work.
 */
const MAX_DELIVERIES = 20;

export function createBmiSyncConsumer() {
  return handleCallback(
    async (message: SyncPushMessage, metadata) => {
      const rowId = Number(message?.rowId);
      if (!Number.isFinite(rowId) || rowId <= 0) {
        console.error(
          `[bmi-sync-push] MALFORMED message, dropping:`,
          JSON.stringify(message ?? null),
        );
        return;
      }

      const row = await getSyncRowById(rowId);
      if (!row) {
        console.error(`[bmi-sync-push] row ${rowId} not found — nothing to run.`);
        return;
      }
      // Someone already settled it (the cron won a race, or an earlier delivery
      // succeeded). Not a failure — the outcome we wanted.
      if (row.status !== "pending") {
        console.log(`[bmi-sync-push] row ${rowId} is already ${row.status} — nothing to do`);
        return;
      }

      // Past MAX_DELIVERIES, release the lease so the cron takes over.
      if (metadata.deliveryCount >= MAX_DELIVERIES) {
        console.error(
          `[bmi-sync-push] giving up on row ${rowId} (${row.kind}) after ` +
            `${metadata.deliveryCount} deliveries — releasing it back to the cron.`,
        );
        await markSyncRetry(row, `queue gave up after ${metadata.deliveryCount} deliveries`, {
          countAttempt: false,
        });
        return;
      }

      const barrier = await probeBarrier(row);

      if (barrier.verdict === "impossible") {
        // Waiting cannot help — e.g. the person lives at another center, so this id
        // will never appear here. Park it for a human rather than sitting closed
        // until the give-up deadline reporting "not synced yet" for hours.
        console.error(`[bmi-sync-push] IMPOSSIBLE row ${rowId} (${row.kind}): ${barrier.detail}`);
        await parkSyncRow(row, barrier.detail);
        return;
      }

      if (barrier.verdict === "closed") {
        // The normal path for a brand-new guest. Must never look like an error.
        console.log(
          `[bmi-sync-push] row ${rowId} (${row.kind}) waiting on sync ` +
            `(delivery ${metadata.deliveryCount}): ${barrier.detail}`,
        );
        await markSyncRetry(row, `barrier closed: ${barrier.detail}`, {
          countAttempt: false,
          leaseSeconds: SYNC_LEASE_SECONDS,
        });
        throw new Error(`barrier closed: ${barrier.detail}`);
      }

      if (barrier.verdict !== "open") {
        // An error verdict splits in two, and the split decides whether guest
        // data survives a vendor outage.
        //
        // `unreachable` means we never got an answer — timeout, refused, 5xx.
        // That says nothing about this row, only about the vendor, so it must
        // not burn an attempt any more than a closed barrier does. On
        // 2026-08-13 it did: every delivery through a hung Pandora counted, so
        // rows reached 19-22 attempts in an hour and the queue dropped them at
        // 20 deliveries with the guest's signature never filed. The give-up
        // deadline (12h for a waiver) is what is supposed to bound waiting.
        //
        // A real answer we cannot act on still counts, because that IS about
        // the row and retrying it forever helps nobody.
        const vendorDown = barrier.unreachable === true;
        const state = await markSyncRetry(row, `barrier error: ${barrier.detail}`, {
          countAttempt: !vendorDown,
          leaseSeconds: SYNC_LEASE_SECONDS,
        });
        if (state === "parked") return; // out of patience; the report will show it
        throw new Error(`barrier error: ${barrier.detail}`);
      }

      const handler = SYNC_HANDLERS[row.kind];
      if (!handler) {
        // Unknown kind: park rather than retry forever on something no deploy can run.
        console.error(`[bmi-sync-push] no handler for kind "${row.kind}" (row ${rowId})`);
        await markSyncRetry({ ...row, attempts: 9_999 }, `no handler for kind "${row.kind}"`);
        return;
      }

      // Hold the lease across the handler itself — a slow Pandora write must not let
      // the cron in behind us.
      await leaseSyncRow(row.id, SYNC_LEASE_SECONDS);

      let res;
      try {
        res = await handler(row);
      } catch (err) {
        // Handlers are contracted not to throw; if one does, retry is the safe read.
        res = {
          ok: false,
          retry: true,
          detail: err instanceof Error ? err.message.slice(0, 200) : "threw",
        };
      }

      if (res.ok) {
        await markSyncDone(row.id, res.detail);
        console.log(
          `[bmi-sync-push] row ${rowId} ${row.kind} DONE in ${metadata.deliveryCount} ` +
            `deliver${metadata.deliveryCount === 1 ? "y" : "ies"}: ${res.detail ?? "ok"}`,
        );
        return;
      }
      if (res.retry === false) {
        // Terminal — a real fault, not a wait.
        await markSyncRetry({ ...row, attempts: 9_999 }, res.detail);
        console.error(`[bmi-sync-push] row ${rowId} ${row.kind} TERMINAL: ${res.detail}`);
        return;
      }
      const state = await markSyncRetry(row, res.detail, { leaseSeconds: SYNC_LEASE_SECONDS });
      if (state === "parked") return;
      throw new Error(res.detail ?? "handler asked to retry");
    },
    {
      // Longer than the Pandora round trips a handler does, so the SDK's automatic
      // visibility extension never has to race a slow vendor.
      visibilityTimeoutSeconds: 120,
      retry: (_error, metadata) => ({ afterSeconds: retrySeconds(metadata.deliveryCount) }),
    },
  );
}
