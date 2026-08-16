/**
 * Vercel Queues consumer — files a captured waiver with BMI.
 *
 * Push mode: Vercel invokes this when the message becomes visible (see
 * WAIVER_PUSH_DELAY_SECONDS). Nothing polls, and there is no cron in this path.
 *
 * ── WHY THIS IS A FACTORY, AND NOT JUST A ROUTE ─────────────────────────────
 * The topic is environment-scoped (`waiverTopic()`), and Vercel binds EXACTLY ONE
 * `queue/v2beta` trigger per function — two entries under one route is a build
 * error, not a warning:
 *
 *   functions["app/api/queue/waiver-push/route.ts"].experimentalTriggers
 *   can only have one item for queue/v2beta
 *
 * That error surfaces in `onBuildComplete`, AFTER a clean compile and all 350
 * static pages, and Vercel produces no deployment at all — so the branch simply
 * stops appearing in previews with nothing obviously wrong (2026-08-13).
 *
 * So each topic gets its own route file, and both call this factory. The handler
 * is identical; only the binding in `vercel.json` differs.
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

/**
 * The barrier said "not yet" — and WHETHER WE GOT AN ANSWER decides the schedule.
 *
 * `unreachable` is the flag personLocalBarrier already sets when the vendor never
 * answered at all (timeout, refused, 502-504). Its own doc says that case "must
 * not spend the row's patience" and points here — this is the consumer that was
 * meant to read it, and until now did not.
 */
class BarrierWaitError extends Error {
  readonly unreachable: boolean;
  constructor(message: string, unreachable: boolean) {
    super(message);
    this.name = "BarrierWaitError";
    this.unreachable = unreachable;
  }
}

/**
 * Redelivery delay while we wait for BMI cloud→local sync.
 *
 * Flat and short for the first several attempts, because the thing we are waiting
 * for lands in 10-32s — exponential backoff here would turn a 12-second wait into
 * a two-minute one for no reason. Only once we are clearly past the normal window
 * does it stretch out.
 *
 * UNLESS WE NEVER REACHED THE VENDOR, which is a different question with a
 * different answer. A 10-second retry is right when we are waiting on a sync that
 * lands in half a minute; it is actively harmful when the upstream is the thing
 * that is broken, because every attempt costs up to three Pandora GETs holding a
 * 15-second connection each, and we are spending them on an API that is already
 * failing to answer. Measured in production 2026-08-14: ~10 rows stuck on timeout
 * retried every 10s for 20 deliveries, and `/api/queue/waiver-push` climbed from
 * 6.0 to 10.1 upstream timeouts/minute across five consecutive windows while
 * everything else was being brought down. Congestive collapse — the slower Pandora
 * got, the harder we hit it.
 *
 * Backing off does not cost the guest anything real: these rows are NOT filing at
 * ten seconds either. It costs the vendor less and therefore recovers sooner, and
 * the schedule below still gives a row ~85 minutes of patience before MAX_DELIVERIES
 * retires it — far longer than the 20 minutes the fast path allows, which is the
 * point of the distinction. A genuine "not local yet" wait is untouched.
 */
function barrierRetrySeconds(deliveryCount: number, unreachable: boolean): number {
  if (unreachable) {
    if (deliveryCount <= 2) return 60;
    if (deliveryCount <= 5) return 180;
    return 300;
  }
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

/**
 * Build the POST handler for one topic binding. Called once per route file — one
 * `handleCallback` instance per function, which is what the SDK expects.
 */
export function createWaiverPushConsumer() {
  return handleCallback(
    async (message: WaiverPushMessage, metadata) => {
      const { signatureRowId, personId, signerPersonId, locationId, name } = message ?? {};
      if (!signatureRowId || !personId || !locationId) {
        // Unfixable payload — throwing would retry forever. Acknowledge and shout.
        console.error(
          `[waiver-push] MALFORMED message, dropping:`,
          JSON.stringify(message ?? null),
        );
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
        // Store the reason, not just the verdict — this is the ONLY place the
        // board can learn WHY, and a fixed "push failed" string made two
        // unrelated causes look like one bug for a full day (2026-08-15).
        await settleWaiverSignature(Number(signatureRowId), "failed", null, barrier.detail);
        return;
      }

      if (barrier.verdict !== "open") {
        // Not yet (or we could not ask). Throwing hands control to the `retry`
        // callback below, which schedules redelivery — this is the normal path for a
        // brand-new guest and must never look like an error in the logs.
        console.log(
          `[waiver-push] row ${signatureRowId} waiting on sync (delivery ${metadata.deliveryCount}): ${barrier.detail}`,
        );
        // The flag rides the error because `retry` below only ever sees the error
        // and the metadata — it has no other way to tell "BMI is down" from
        // "this guest has not synced yet", and those want opposite schedules.
        throw new BarrierWaitError(
          `barrier ${barrier.verdict}: ${barrier.detail}`,
          barrier.unreachable === true,
        );
      }

      const { signWaiverDigital } = await import("@/lib/waiver-digital");
      const out = await signWaiverDigital({
        personId: String(personId),
        name: String(name || "").trim() || "Guest",
        // WHICH CENTER. Without this, `resolvePandoraLocation(undefined)` falls back
        // to FastTrax and the write goes to a center where this person id does not
        // exist — BMI ids do not cross centers. The barrier above already used this
        // id and passed; only the sign call was missing it, so a HeadPinz Naples
        // waiver retried for 23 minutes and never filed (#809/#811, 2026-08-13).
        locationId,
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
      retry: (error, metadata) => {
        if (metadata.deliveryCount >= MAX_DELIVERIES) {
          console.error(
            `[waiver-push] giving up after ${metadata.deliveryCount} deliveries — ` +
              `the Neon row stays unsettled and will show in the owed list.`,
          );
          return { acknowledge: true };
        }
        // Anything that is NOT a barrier wait (a thrown sign call, a bad payload
        // that got this far) keeps the original fast schedule — `unreachable` is
        // a statement about the vendor, and we only have one when the barrier made it.
        const unreachable = error instanceof BarrierWaitError && error.unreachable;
        return { afterSeconds: barrierRetrySeconds(metadata.deliveryCount, unreachable) };
      },
    },
  );
}
