/**
 * Vercel Queues consumer — files a captured waiver with BMI.
 *
 * Push mode: Vercel invokes this when the message becomes visible (see
 * WAIVER_PUSH_DELAY_SECONDS). Nothing polls, and there is no cron in this path.
 *
 * ── THE BARRIER IS A RETRY, NOT A FAILURE ───────────────────────────────────
 * Pandora writes against the center's LOCAL server, so both the person and (for a
 * minor) the signing guardian must be visible there first. When they are not, this
 * asks for redelivery in a few seconds. That is the whole reason this transport is
 * better than the cron: `bmi_sync_queue` answered a closed barrier with a 30s
 * backoff AND then waited for the next every-2-minutes tick, so "not synced yet" cost
 * minutes. Here it costs seconds.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 * Neon is the source of truth. The message carries a `waiver_signatures.id`; the
 * image and the filing details are read from that row. So a lost or expired
 * message costs a vendor record we can re-push, never a guest's signature.
 *
 * Visibility timeout gives us the claim for free: an in-flight message is
 * invisible to other consumers, and becomes visible again by itself if this
 * handler dies mid-flight. That is exactly the `FOR UPDATE SKIP LOCKED` claim plus
 * stale-row reaper that `bmi_sync_queue` still lacks.
 */
import { handleCallback } from "@vercel/queue";
import { getWaiverSignatureById, settleWaiverSignature } from "@/lib/waiver-signature-store";
import { personsLocalBarrier } from "@/lib/bmi-sync-barriers";
import type { WaiverPushMessage } from "~/features/kiosk/waiver/waiver-queue";

/** The push itself is a couple of Pandora round trips; 60s is ample headroom. */
export const maxDuration = 60;

/**
 * Redelivery delay while we wait for BMI cloud→local sync.
 *
 * Flat and short for the first several attempts, because the thing we are waiting
 * for lands in 10-32s — exponential backoff here would turn a 12-second wait into
 * a two-minute one for no reason. Only once we are clearly past the normal window
 * does it stretch out.
 */
function barrierRetrySeconds(deliveryCount: number): number {
  if (deliveryCount <= 4) return 10;
  if (deliveryCount <= 10) return 30;
  return 120;
}

/**
 * Give up asking. At ~20 deliveries with the schedule above we are roughly 20
 * minutes past the signature, which is far outside any normal sync window — the
 * cause is a real fault (wrong center, missing person, vendor outage), and
 * quietly retrying for another 23 hours hides it. Acknowledge, and leave the Neon
 * row unsettled so it shows up in the owed list.
 */
const MAX_DELIVERIES = 20;

export const POST = handleCallback(
  async (message: WaiverPushMessage, metadata) => {
    const { signatureRowId, personId, signerPersonId, locationId, name } = message ?? {};
    if (!signatureRowId || !personId || !locationId) {
      // Unfixable payload — throwing would retry forever. Acknowledge and shout.
      console.error(`[waiver-push] MALFORMED message, dropping:`, JSON.stringify(message ?? null));
      return;
    }

    const row = await getWaiverSignatureById(Number(signatureRowId));
    if (!row) {
      console.error(
        `[waiver-push] signature row ${signatureRowId} not found — nothing to file. ` +
          `A message older than its row should be impossible; investigate rather than retry.`,
      );
      return;
    }

    // Someone already filed it (the inline sign won a race, or an earlier delivery
    // of this message succeeded). Not a failure — the outcome we wanted.
    if (row.waiverId) {
      console.log(`[waiver-push] row ${signatureRowId} already filed as waiver ${row.waiverId}`);
      return;
    }

    // BOTH people must be resolvable locally — the minor AND the signing guardian.
    const ids = [...new Set([String(personId), String(signerPersonId || personId)])];
    const barrier = await personsLocalBarrier(locationId, ids);

    if (barrier.verdict === "impossible") {
      // Waiting cannot help — e.g. the person lives at another center, so this id
      // will never appear here. Stop, and leave the row unsettled so it lands in
      // the owed list for a human.
      console.error(`[waiver-push] IMPOSSIBLE for row ${signatureRowId}: ${barrier.detail}`);
      await settleWaiverSignature(Number(signatureRowId), "failed", null);
      return;
    }

    if (barrier.verdict !== "open") {
      // Not yet (or we could not ask). Throwing hands control to the `retry`
      // callback below, which schedules redelivery — this is the normal path for a
      // brand-new guest and must never look like an error in the logs.
      console.log(
        `[waiver-push] row ${signatureRowId} waiting on sync (delivery ${metadata.deliveryCount}): ${barrier.detail}`,
      );
      throw new Error(`barrier ${barrier.verdict}: ${barrier.detail}`);
    }

    const { signWaiverDigital } = await import("@/lib/waiver-digital");
    const out = await signWaiverDigital({
      personId: String(personId),
      name: String(name || "").trim() || "Guest",
      // Every field the guest was actually shown, straight from the stored row —
      // omitting any of them lets signWaiverDigital's EVENT-waiver defaults win
      // (age-35 adult template, 5-day expiry, self-signed), which is precisely how
      // a queued minor's waiver got mis-filed before 2026-08-13.
      waiverContentID: row.waiverContentId,
      invalidationDate: row.invalidationDate ?? undefined,
      signerPersonId: row.signerPersonId,
      pngBuffer: row.signatureBase64 ? Buffer.from(row.signatureBase64, "base64") : undefined,
      // A waiver acquired another way in the meantime must not be shortened.
      skipIfValid: true,
    });

    if (out.skipped) {
      console.log(`[waiver-push] row ${signatureRowId} — person already had a valid waiver`);
      await settleWaiverSignature(Number(signatureRowId), "salvaged", null);
      return;
    }
    if (!out.waiverID) {
      // signWaiverDigital throws on a non-write, so this is belt-and-braces.
      throw new Error("no waiverID returned");
    }

    await settleWaiverSignature(Number(signatureRowId), "signed", String(out.waiverID));
    console.log(
      `[waiver-push] filed row ${signatureRowId} as waiver ${out.waiverID} ` +
        `(delivery ${metadata.deliveryCount}, ${ids.length === 1 ? "self-signed" : "guardian-signed"})`,
    );
  },
  {
    // Longer than the two Pandora round trips this does, so the SDK's automatic
    // visibility extension never has to race a slow vendor.
    visibilityTimeoutSeconds: 120,
    retry: (_error, metadata) => {
      if (metadata.deliveryCount >= MAX_DELIVERIES) {
        console.error(
          `[waiver-push] giving up after ${metadata.deliveryCount} deliveries — ` +
            `the Neon row stays unsettled and will show in the owed list.`,
        );
        return { acknowledge: true };
      }
      return { afterSeconds: barrierRetrySeconds(metadata.deliveryCount) };
    },
  },
);
