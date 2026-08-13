/**
 * Vercel Queues transport for the waiver push.
 *
 * ── WHY, over the Neon `bmi_sync_queue` cron ────────────────────────────────
 * The existing queue is polled by a every-2-minutes cron, and a row whose barrier is closed
 * gets a 30s backoff before it is even reconsidered. So the floor on "BMI has the
 * waiver" was roughly 1-4 minutes and the cron cadence was only half of it
 * (measured reasoning, 2026-08-13). Queues replaces the polling with:
 *
 *   delaySeconds       — the message becomes visible when we EXPECT the person to
 *                        have reached the local server, instead of whenever a cron
 *                        happens to fire.
 *   push delivery      — Vercel invokes the consumer at that moment.
 *   retry afterSeconds — a closed barrier re-delivers in seconds, not "30s backoff
 *                        plus wait for the next tick".
 *   visibility timeout — an in-flight message is invisible to other consumers, and
 *                        becomes visible again on its own if the handler dies.
 *                        That is the atomic claim AND the stale-row reaper we would
 *                        otherwise have had to build on `bmi_sync_queue`, whose
 *                        due-row query claims nothing today.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * NOT the source of truth. `waiver_signatures` in Neon holds the signature, terms
 * version, timestamp and image, written BEFORE anything is sent (house rule). A
 * message carries only the INTENT to push, identified by that row's id. Losing
 * every message in this topic would cost us vendor records, never a guest's
 * waiver.
 *
 * The other `bmi_sync_queue` kinds (membership grants, birthdate repairs, state
 * stamps) deliberately stay on the cron: nobody is waiting on them, so their
 * latency does not matter and two transports is cheaper than one big migration.
 */
import { PANDORA_LOCATION_MAP } from "@/lib/pandora-locations";

/**
 * Topic name is ENVIRONMENT-SCOPED, and this is not optional.
 *
 * Preview deployments share the production Neon database — we found that out when
 * a preview-written `persons-local` queue row landed in production's table with a
 * barrier production's code did not recognise (2026-08-13). A shared message topic
 * is the same hazard with worse consequences: a preview consumer could receive,
 * push, and ACKNOWLEDGE a real guest's waiver, and production would never see it.
 *
 * Separate topics make that structurally impossible. Cheaper than reasoning about
 * `Vqs-Deployment-Id` semantics, and it fails safe if I have those wrong.
 */
export function waiverTopic(): string {
  return process.env.VERCEL_ENV === "production" ? "waiver-push" : "waiver-push-preview";
}

/**
 * KILL SWITCH, not an opt-in gate (house rule: a merged feature is ON). Set
 * `WAIVER_QUEUE_VERCEL=false` to fall back to the Neon `bmi_sync_queue` enqueue,
 * which stays in place and working.
 */
export function waiverQueueEnabled(): boolean {
  return process.env.WAIVER_QUEUE_VERCEL !== "false";
}

/**
 * How long before the first delivery attempt.
 *
 * Matched to the MEASURED cloud→local sync window (10-32s, and the person is
 * usually minted several seconds before the guest finishes reading the waiver).
 * Delivering sooner just burns a retry on a closed barrier; much later leaves the
 * record owed for no reason. The consumer's own retry handles the tail.
 */
export const WAIVER_PUSH_DELAY_SECONDS = 20;

/** Everything the consumer needs. NO signature image — see `signatureRowId`. */
export interface WaiverPushMessage {
  /** `waiver_signatures.id`. The consumer reads the image and the filing details
   *  from Neon, so the message stays under one 4 KiB billing chunk and no guest
   *  data rides the bus. */
  signatureRowId: number;
  /** Whose waiver. */
  personId: string;
  /** WHO SIGNED — the guardian for a minor's waiver, else the person themselves.
   *  Carried explicitly because a minor's consent record is meaningless without
   *  it, and the default in `signWaiverDigital` is to name the person as their own
   *  signer. */
  signerPersonId: string;
  /** Pandora location id the waiver must be filed at. */
  locationId: string;
  /** Display name for the rendered mark when no drawn image survives. */
  name: string;
}

/**
 * Hand the push to Vercel Queues. Returns the message id, or null when the send
 * failed — callers MUST treat null as "fall back to the Neon queue", never as
 * "done", because a lost push is a vendor record we owe a guest.
 *
 * Errors are swallowed on purpose: the signature is already durable, and a queue
 * outage must not turn into a failed waiver on the guest's screen.
 */
export async function sendWaiverPush(msg: WaiverPushMessage): Promise<string | null> {
  if (!waiverQueueEnabled()) return null;
  try {
    const { send } = await import("@vercel/queue");
    const { messageId } = await send(waiverTopic(), msg, {
      delaySeconds: WAIVER_PUSH_DELAY_SECONDS,
      // Per SIGNATURE ROW, not per person-per-day: two legitimate signatures in
      // one visit are two different records to file, and collapsing them would
      // silently drop one. The row id is already unique.
      idempotencyKey: `waiver-sig-${msg.signatureRowId}`,
      // Long enough to cover a Pandora outage plus the retry ladder, far short of
      // the 7-day maximum — a waiver still unfiled after a day is an incident for
      // a human, not something to keep retrying quietly.
      retentionSeconds: 24 * 60 * 60,
    });
    return messageId ?? null;
  } catch (err) {
    // DuplicateMessageError is a SUCCESS in disguise: the push is already in
    // flight from an earlier submit of this same signature row.
    const name = err instanceof Error ? err.name : "";
    if (name === "DuplicateMessageError") {
      console.log(`[waiver-queue] row ${msg.signatureRowId} already queued — treating as sent`);
      return "duplicate";
    }
    console.warn(
      `[waiver-queue] send failed for signature row ${msg.signatureRowId} — falling back to the Neon queue:`,
      err,
    );
    return null;
  }
}

/** Guard: a location we can actually file against. */
export function isKnownPandoraLocation(locationId: string): boolean {
  return Object.values(PANDORA_LOCATION_MAP).includes(locationId);
}
