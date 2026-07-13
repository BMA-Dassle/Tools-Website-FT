import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { listRecentVideos, setVideoDisabled, linkCustomerEmail, type Vt3Video } from "@/lib/vt3";
import { matchVideoToAssignment } from "@/lib/video-event-processor";
import {
  updateVideoMatch,
  getMatchByVideoCode,
  getLastSeenVideoId,
  setLastSeenVideoId,
  isVideoReadyForNotify,
  type VideoMatch,
} from "@/lib/video-match";
import { notifyVideoReady, cameraHistoryEntryFromMatch } from "@/lib/video-notify";
import { getBlockState } from "@/lib/video-block";
import { logCronRun } from "@/lib/sms-log";
import { verifyCron } from "@/lib/cron-auth";

/**
 * GET /api/cron/video-match
 *
 * Polls vt3.io /videos (the Viewpoint control-panel feed) every few
 * minutes and matches each fresh record back to the racer whose NFC
 * tag was bound to that camera/kart during the race.
 *
 * Pipeline:
 *   1. Fetch the latest 50 videos from VT3 for the FastTrax site
 *      (VT3_SITE_ID), newest-first.
 *   2. Trim to ones newer than `vt3:last-seen-id`. First run processes
 *      up to 50 most-recent; subsequent runs only process the delta.
 *   3. For each, skip if already matched (sentinel key).
 *   4. Match via the shared matchVideoToAssignment helper: walk the
 *      camera-history entries scanned at-or-before the video's
 *      `created_at` OLDEST-first and take the earliest assignment
 *      that doesn't already hold a video — multiple videos from one
 *      camera pair to multiple assignments in order. Critical for
 *      multi-heat days where the same kart runs two or three
 *      different racers. If every eligible assignment already has a
 *      video, the record is HELD in the review bucket (no SMS) for
 *      manual send from the videos admin.
 *   5. On a match, persist it
 *      (video-match:{sessionId}:{personId} + video-match:by-code
 *      sentinel).
 *   6. Always advance `vt3:last-seen-id` to the highest id we saw, even
 *      if none of the videos matched — prevents re-processing.
 *
 * A short Redis lock prevents two overlapping runs from double-fetching
 * and double-matching. Lock TTL 90s, released in finally.
 *
 * Schedule (vercel.json): every 2 minutes. Videos don't upload instantly
 * — they arrive 5–30 min after scan-out — so a 2-min cadence keeps the
 * UI fresh without hammering VT3.
 *
 * Env vars required:
 *   VT3_USERNAME
 *   VT3_PASSWORD
 *   VT3_SITE_ID  — integer, FastTrax = 992
 */

const CRON_LOCK_KEY = "cron-lock:video-match";
const CRON_LOCK_TTL = 90;

/**
 * Pull VT3's impression + purchase fields off a /videos record into
 * the shape we persist on each VideoMatch. Called on every video every
 * tick so the admin UI's "viewed" / "purchased" chips stay fresh even
 * after the match row is fully notified and past the lastSeenId cursor.
 *
 * `viewed` collapses VT3's two impression flags + the firstImpressionAt
 * timestamp into one boolean — any of those being truthy means a racer
 * (or anyone with the link) has loaded the player. `purchased` keys off
 * unlockTime, which VT3 sets when the vid is unlocked via the purchase
 * flow. Keeping both booleans + the raw timestamps/strings lets the UI
 * render a chip AND a tooltip without re-deriving.
 */
type Overlay = {
  viewed?: boolean;
  firstViewedAt?: string;
  lastViewedAt?: string;
  purchased?: boolean;
  purchaseType?: string;
  unlockedAt?: string;
};

function extractOverlay(v: Vt3Video): Overlay {
  const viewed =
    !!v.hasVideoPageImpression || !!v.hasMediaCentreImpression || !!v.firstImpressionAt;
  const unlockedAt = v.unlockTime || undefined;
  // VT3 considers ANY unlockTime → purchased (PAID, unlockCode,
  // and the rest are all paid paths per staff). Reverted from the
  // brief PAID-only gate.
  const purchased = !!unlockedAt;
  return {
    viewed: viewed || undefined,
    firstViewedAt: v.firstImpressionAt || undefined,
    lastViewedAt: v.lastImpressionAt || undefined,
    purchased: purchased || undefined,
    purchaseType: v.purchaseType || undefined,
    unlockedAt,
  };
}

/** True when any of the overlay fields differs from what's already
 *  persisted on the record. Used to gate the Redis write so the cron
 *  doesn't churn 200 SETs/tick when nothing has changed. */
function overlayDiffers(m: VideoMatch, o: Overlay): boolean {
  return (
    m.viewed !== o.viewed ||
    m.firstViewedAt !== o.firstViewedAt ||
    m.lastViewedAt !== o.lastViewedAt ||
    m.purchased !== o.purchased ||
    m.purchaseType !== o.purchaseType ||
    m.unlockedAt !== o.unlockedAt
  );
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const force = new URL(req.url).searchParams.get("force") === "1";
  const started = Date.now();

  // ── Heartbeat-gated backstop ──
  // The webhook at /api/webhooks/vt3-video-event updates
  // `vt3:bridge:last-event` on every accepted message event from
  // the Railway bridge. As long as that timestamp is fresh, the
  // webhook + processVideoEvent are doing all the work — match
  // creation, overlay refresh, block sync, notify firing — in
  // sub-second latency. This polling cron then only needs to run
  // when the bridge has gone silent (Railway outage, JWT expiry,
  // VT3 endpoint down, etc.).
  //
  // Threshold: 5 min. VT3 always has SOME activity during operating
  // hours (status transitions on encoding videos, impression
  // updates, etc.) so a 5-min gap is a strong signal something's
  // wrong upstream. Off-hours quiet windows would trigger a backstop
  // run, which is harmless — the run is bounded and idempotent.
  //
  // ?force=1 bypasses the heartbeat check for manual debug runs.
  if (!dryRun && !force) {
    try {
      const lastEvent = await redis.get("vt3:bridge:last-event");
      if (lastEvent) {
        const lastMs = new Date(lastEvent).getTime();
        const ageMs = Date.now() - lastMs;
        const STALE_THRESHOLD_MS = 5 * 60 * 1000;
        if (Number.isFinite(lastMs) && ageMs < STALE_THRESHOLD_MS) {
          console.log(
            `[video-match] bridge alive (last event ${Math.round(ageMs / 1000)}s ago) — skipping backstop pass`,
          );
          return NextResponse.json(
            {
              ok: true,
              skipped: "bridge-alive",
              lastBridgeEvent: lastEvent,
              ageSeconds: Math.round(ageMs / 1000),
              elapsedMs: Date.now() - started,
            },
            { headers: { "Cache-Control": "no-store" } },
          );
        }
        console.log(
          `[video-match] bridge stale (last event ${Math.round(ageMs / 1000)}s ago) — running backstop pass`,
        );
      } else {
        console.log("[video-match] no bridge heartbeat key — running backstop pass");
      }
    } catch (err) {
      console.warn("[video-match] heartbeat check failed, running backstop pass anyway:", err);
    }
  }

  // Concurrency lock (same pattern as pre-race-tickets cron).
  if (!dryRun) {
    const acquired = await redis.set(CRON_LOCK_KEY, "1", "EX", CRON_LOCK_TTL, "NX");
    if (!acquired) {
      return NextResponse.json(
        { ok: true, locked: true, note: "previous run still in flight" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  let fetched = 0;
  let skippedAlreadyMatched = 0;
  let skippedNoAssignment = 0;
  let skippedOld = 0;
  let skippedNotReady = 0; // match row exists + still waiting on VT3
  let heldDuplicate = 0; // every eligible assignment already has a video — held for review
  let savedPending = 0; // NEW match, saved with pendingNotify=true
  let deferredSent = 0; // pending match turned ready, notify fired on this tick
  let matched = 0; // new match + immediate notify (VT3 already ready)
  let skippedBlocked = 0; // NEW match, blocked via camera-assign — saved but no notify
  let unblockedAndSent = 0; // existing blocked match detected as unblocked this tick, notify fired
  let vt3Linked = 0; // successful POST /videos/{code}/customer calls
  let vt3DisabledFlips = 0; // successful PUT /videos/by-code/{code} disabled:{bool} calls
  let errors = 0;

  // Holding rules: notify only fires when VT3 status is one of the
  // known-viewable states (PENDING_ACTIVATION, UPLOADED, ACTIVE, READY).
  // ALLOWLIST — any new state VT3 introduces (e.g. ENCODING, which
  // recently slipped through our prior blocklist and sent SMS for a
  // still-processing video) holds by default. See
  // `VIDEO_READY_STATUSES` in lib/video-match.ts for the canonical list.
  const matches: {
    videoCode: string;
    systemNumber: string;
    cameraNumber?: number;
    racer: string;
    sessionId: string | number;
  }[] = [];

  try {
    const siteId = parseInt(process.env.VT3_SITE_ID || "992", 10);

    // Pull the newest 500. Higher than strictly needed for new-match
    // detection, but the cron's overlay-refresh pass also runs over
    // every video in this set — so a wider window keeps older match
    // records' viewed/purchased/unlock fields in sync with VT3 longer
    // before they age out. (Reported case: a stale unlock fields
    // lingered on a record that scrolled off a 200-window during a
    // busy race day.)
    const [videos, lastSeenId] = await Promise.all([
      listRecentVideos({ siteId, limit: 500 }),
      getLastSeenVideoId(),
    ]);

    // VT3 returns id:desc (newest first). Process oldest-first so two
    // videos from the same camera arriving in one batch pair to
    // assignments IN ORDER — iterating newest-first would hand the
    // LATER video the earlier unfilled slot. The rest of the loop is
    // order-independent (overlay pass is per-item, highestId is a max).
    videos.sort((a, b) => {
      const at = new Date(a.created_at).getTime();
      const bt = new Date(b.created_at).getTime();
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
      return a.id - b.id;
    });

    // Only advance lastSeenId past videos we actually finished with
    // (either matched, ready-but-no-assignment, or fatal error). Videos
    // we skip because they're not ready yet keep their id "unseen" so
    // the next cron tick will retry them once VT3 transitions the state.
    let highestId = lastSeenId;

    // Small helper: fire SMS/email + patch notify fields onto the record.
    // Used by both the immediate-notify branch (new match, VT3 ready) and
    // the deferred-notify branch (existing pending match, VT3 now ready).
    const fireNotify = async (record: VideoMatch): Promise<void> => {
      try {
        const entry = cameraHistoryEntryFromMatch(record);
        const n = await notifyVideoReady(record, entry);
        const nowIso = new Date().toISOString();
        if (n.sms.attempted) {
          record.notifySmsOk = n.sms.ok;
          record.notifySmsError = n.sms.error;
          record.notifySmsSentTo = n.sms.sentTo;
          record.notifySmsSentAt = nowIso;
          // Carry the Vox messageId onto the record so the Vox
          // webhook (/api/sms-webhook/vox) can patch in the
          // carrier DLR delivery state when it fires.
          if (n.sms.providerMessageId) {
            record.notifySmsProviderMessageId = n.sms.providerMessageId;
          }
        }
        if (n.email.attempted) {
          record.notifyEmailOk = n.email.ok;
          record.notifyEmailError = n.email.error;
          record.notifyEmailSentTo = n.email.sentTo;
          record.notifyEmailSentAt = nowIso;
        }
        // Capture which recipient the picker chose so the admin board
        // can render the "↻ guardian" chip.
        if (n.recipient) {
          record.viaGuardian = n.recipient === "guardian" || undefined;
        }
        record.pendingNotify = false;
        await updateVideoMatch(record).catch(() => void 0);
      } catch (err) {
        console.error(`[video-match] notify error for code=${record.videoCode}:`, err);
      }
    };

    for (const v of videos) {
      fetched++;

      // Always-run overlay pass: mirror VT3's impression + purchase
      // fields onto any existing match record for this video code,
      // regardless of cursor position or readiness state. Also re-
      // resolves block state each tick so VT3's `disabled` flag stays
      // in sync with our source-of-truth block keys, and a deferred
      // notify fires the tick we detect a block→unblock flip.
      //
      // Cheap: at most `videos.length` GETs/tick (≤200), and we only
      // SET / call VT3 when something actually changed.
      const overlay = extractOverlay(v);
      const existing = await getMatchByVideoCode(v.code);

      // Will be set true by the overlay pass if it finishes this video
      // (e.g., fires a deferred notify on unblock) — skips PATH 1 below.
      let overlayHandled = false;

      if (existing) {
        const overlayChanged = overlayDiffers(existing, overlay);
        // Mutate in place AFTER the diff check so any subsequent write
        // carries overlay fields forward. See `overlayDiffers`.
        Object.assign(existing, overlay);

        // Resolve block state from the block keys — source of truth
        // outside this record. Mirror onto `existing` for the admin UI.
        const blockState = await getBlockState({
          sessionId: existing.sessionId,
          personId: existing.personId,
          videoCode: v.code,
        });
        const wasBlocked = !!existing.blocked;
        const isBlocked = blockState.blocked;
        const blockChanged = wasBlocked !== isBlocked;

        if (blockChanged) {
          existing.blocked = isBlocked || undefined;
          existing.blockLevel = blockState.level;
          existing.blockReason = blockState.reason;
          existing.blockedAt = isBlocked ? blockState.blockedAt : undefined;

          // Sync VT3's `disabled` flag with our block state. Best-effort
          // — log failure but keep Redis authoritative.
          if (!dryRun) {
            try {
              await setVideoDisabled(v.code, isBlocked);
              vt3DisabledFlips++;
            } catch (err) {
              console.error(`[video-match] setVideoDisabled(${v.code},${isBlocked}) failed:`, err);
            }
          }

          // Block → Unblock: mark pending-notify so the "ready to fire"
          // branch below (or a later tick once VT3 is ready) picks it
          // up. If the record was already notified before it got
          // blocked, leave pendingNotify alone — no re-send.
          if (wasBlocked && !isBlocked) {
            const neverNotified = !existing.notifySmsSentAt && !existing.notifyEmailSentAt;
            if (neverNotified) existing.pendingNotify = true;
          }
        }

        // Ready-to-fire check: handles both the block→unblock transition
        // we may have just made AND legacy pending-notify records that
        // sit past the lastSeenId cursor (PATH 1 only runs inside the
        // cursor; this branch runs for every fetched record).
        //
        // We suppress this pass during dry runs so the counters stay
        // honest without hitting VT3 or Voxtelesys.
        // Sample-based gate — fire as soon as VT3 has uploaded the
        // preview clip (sampleUploadTime != null). Status name acts
        // as a fallback only. The /check endpoint's `sample.url`
        // mirrors sampleUploadTime, so this matches what the public
        // viewer at vt3.io/?code=X will actually play.
        const vt3Ready = isVideoReadyForNotify({
          status: v.status,
          sampleUploadTime: v.sampleUploadTime,
        });
        const shouldFireNow = !existing.blocked && existing.pendingNotify === true && vt3Ready;

        if (shouldFireNow) {
          if (dryRun) {
            // Count as unblocked-and-sent vs deferred-sent so dry-run
            // output distinguishes the two signals.
            if (blockChanged) unblockedAndSent++;
            else deferredSent++;
            overlayHandled = true;
          } else {
            // Push email to VT3 customer profile so the racer's vt3.io
            // account has the vid linked when they tap the SMS. Only
            // set the tracking fields when the call actually ran — it
            // no-ops when the feature is disabled via env so records
            // don't get marked "linked" and skip future retries.
            if (existing.email && !existing.vt3CustomerLinked) {
              try {
                const linked = await linkCustomerEmail(v.code, existing.email);
                if (linked) {
                  existing.vt3CustomerLinked = true;
                  existing.vt3CustomerLinkedEmail = existing.email;
                  existing.vt3CustomerLinkedAt = new Date().toISOString();
                  vt3Linked++;
                }
              } catch (err) {
                console.error(`[video-match] linkCustomerEmail(${v.code}) failed:`, err);
              }
            }
            existing.videoStatus = v.status;
            existing.sampleUploadTime = v.sampleUploadTime ?? undefined;
            existing.uploadTime = v.uploadTime ?? undefined;
            await fireNotify(existing); // also updates the record
            if (blockChanged) unblockedAndSent++;
            else deferredSent++;
            if (v.id > highestId) highestId = v.id;
            overlayHandled = true;
          }
        } else if ((overlayChanged || blockChanged) && !dryRun) {
          // No notify to fire — just persist the overlay / block mirror
          // changes we made in memory.
          try {
            await updateVideoMatch(existing);
          } catch (err) {
            console.error(`[video-match] overlay update failed for code=${v.code}:`, err);
          }
        }
      }

      if (overlayHandled) continue;

      if (v.id <= lastSeenId) {
        skippedOld++;
        continue;
      }

      // Held until VT3 has uploaded the preview clip. Sample-based
      // gate — sampleUploadTime presence means the public viewer can
      // play SOMETHING, so racer SMS won't land on a "still processing"
      // page. Status fallback covers older-style videos.
      const notReady = !isVideoReadyForNotify({
        status: v.status,
        sampleUploadTime: v.sampleUploadTime,
      });

      // -----------------------------------------------------------------
      // PATH 1: existing match (prior cron run already created a record).
      // If it's pending-notify and the video has now transitioned to a
      // preview-ready status, fire the notification now + mark ready.
      // Otherwise skip.
      // -----------------------------------------------------------------
      if (existing) {
        if (existing.blocked) {
          // Blocked match — overlay pass has already kept VT3 in sync.
          // Don't notify, don't double-count. Advance cursor so we don't
          // re-visit every tick (the overlay pass still handles unblock
          // even when we're past lastSeenId).
          if (v.id > highestId) highestId = v.id;
          skippedAlreadyMatched++;
          continue;
        }
        if (!existing.pendingNotify) {
          // Fully done in a prior run.
          if (v.id > highestId) highestId = v.id;
          skippedAlreadyMatched++;
          continue;
        }
        // Pending match. Is it ready yet?
        if (notReady) {
          // Refresh the stored VT3 status so the admin UI reflects the
          // actual upload-pipeline state (TRANSFERRING → FOR_ENCODING →
          // IS_ENCODING → PENDING_ACTIVATION). Without this the row
          // would forever show the status we saw on first match — that
          // was reported as videos "stuck on Pending Upload" when VT3
          // had actually moved them along. Skip persist when nothing
          // changed to keep Redis writes minimal.
          const newSample = v.sampleUploadTime ?? undefined;
          const newUpload = v.uploadTime ?? undefined;
          if (
            existing.videoStatus !== v.status ||
            existing.sampleUploadTime !== newSample ||
            existing.uploadTime !== newUpload
          ) {
            existing.videoStatus = v.status;
            existing.sampleUploadTime = newSample;
            existing.uploadTime = newUpload;
            await updateVideoMatch(existing).catch(() => void 0);
          }
          skippedNotReady++;
          // Don't advance highestId — we'll retry next tick.
          continue;
        }
        // It's ready now. Fire the deferred notify.
        if (dryRun) {
          deferredSent++;
          matches.push({
            videoCode: v.code,
            systemNumber: existing.systemNumber,
            cameraNumber: existing.cameraNumber,
            racer: `${existing.firstName} ${existing.lastName}`,
            sessionId: existing.sessionId,
          });
          continue;
        }
        // Push email to VT3 customer profile so the racer's vt3.io
        // account links the vid before they tap the SMS. Tracking
        // fields only set when the call actually ran (env-gated).
        if (existing.email && !existing.vt3CustomerLinked) {
          try {
            const linked = await linkCustomerEmail(v.code, existing.email);
            if (linked) {
              existing.vt3CustomerLinked = true;
              existing.vt3CustomerLinkedEmail = existing.email;
              existing.vt3CustomerLinkedAt = new Date().toISOString();
              vt3Linked++;
            }
          } catch (err) {
            console.error(`[video-match] linkCustomerEmail(${v.code}) failed:`, err);
          }
        }
        existing.videoStatus = v.status;
        existing.sampleUploadTime = v.sampleUploadTime ?? undefined;
        existing.uploadTime = v.uploadTime ?? undefined;
        await fireNotify(existing);
        if (v.id > highestId) highestId = v.id;
        deferredSent++;
        matches.push({
          videoCode: v.code,
          systemNumber: existing.systemNumber,
          cameraNumber: existing.cameraNumber,
          racer: `${existing.firstName} ${existing.lastName}`,
          sessionId: existing.sessionId,
        });
        continue;
      }

      // -----------------------------------------------------------------
      // PATH 2: no existing record. Match via the shared helper (earliest
      // unfilled assignment, oldest-first — see matchVideoToAssignment in
      // lib/video-event-processor.ts) + save. If VT3 isn't ready, save
      // with pendingNotify=true (admin sees the row now, racer gets the
      // SMS once VT3 transitions). If ready, notify immediately.
      // -----------------------------------------------------------------
      const cameraKey = v.camera != null ? String(v.camera) : "";
      const systemFallbackKey = v.system?.name || "";
      if (!cameraKey && !systemFallbackKey) {
        skippedNoAssignment++;
        continue;
      }

      try {
        const attempt = await matchVideoToAssignment(v, {
          source: "cron",
          ready: !notReady,
          dryRun,
        });

        if (attempt.outcome === "no-assignment") {
          // Unmatched record written by the helper — surfaces in the
          // admin's "all videos for the day" view for manual send.
          if (v.id > highestId) highestId = v.id;
          skippedNoAssignment++;
          continue;
        }
        if (attempt.outcome === "held-duplicate") {
          // Review record written by the helper. Advance the cursor —
          // the divert is deterministic, no point re-holding every tick.
          if (v.id > highestId) highestId = v.id;
          heldDuplicate++;
          continue;
        }
        if (attempt.outcome === "already-processed") {
          skippedAlreadyMatched++;
          continue;
        }

        const { record: matchRecord, blockState } = attempt;

        if (dryRun) {
          matches.push({
            videoCode: v.code,
            systemNumber: systemFallbackKey,
            cameraNumber: v.camera,
            racer: `${matchRecord.firstName} ${matchRecord.lastName}`,
            sessionId: matchRecord.sessionId,
          });
          if (blockState.blocked) skippedBlocked++;
          else if (notReady) savedPending++;
          else matched++;
          continue;
        }

        matches.push({
          videoCode: v.code,
          systemNumber: systemFallbackKey,
          cameraNumber: v.camera,
          racer: `${matchRecord.firstName} ${matchRecord.lastName}`,
          sessionId: matchRecord.sessionId,
        });

        if (blockState.blocked) {
          // Racer bound to the video (so admin sees the row), but
          // notify is suppressed. Flip VT3's `disabled` flag so the
          // customer-facing vt3.io link also won't play. Best-effort.
          try {
            await setVideoDisabled(v.code, true);
            vt3DisabledFlips++;
          } catch (err) {
            console.error(`[video-match] setVideoDisabled(${v.code},true) failed:`, err);
          }
          if (v.id > highestId) highestId = v.id;
          skippedBlocked++;
        } else if (notReady) {
          // Saved as pending. Admin will see the row; notify fires on
          // the next tick once VT3 says ready. Do NOT advance highestId
          // so we revisit this video.
          savedPending++;
        } else {
          // VT3 is ready now — push the racer's email to VT3's customer
          // profile so the vid shows up in their vt3.io account, then
          // fire notify. Email push is best-effort; if it fails we
          // still notify. Tracking fields only set when the call
          // actually ran (env-gated via VT3_LINK_CUSTOMER_ENABLED).
          if (matchRecord.email) {
            try {
              const linked = await linkCustomerEmail(v.code, matchRecord.email);
              if (linked) {
                matchRecord.vt3CustomerLinked = true;
                matchRecord.vt3CustomerLinkedEmail = matchRecord.email;
                matchRecord.vt3CustomerLinkedAt = new Date().toISOString();
                vt3Linked++;
              }
            } catch (err) {
              console.error(`[video-match] linkCustomerEmail(${v.code}) failed:`, err);
            }
          }
          await fireNotify(matchRecord);
          if (v.id > highestId) highestId = v.id;
          matched++;
        }
      } catch (err) {
        console.error(`[video-match] save error for code=${v.code}:`, err);
        errors++;
      }
    }

    // Always advance — even unmatchable videos shouldn't be re-fetched.
    if (!dryRun && highestId > lastSeenId) {
      await setLastSeenVideoId(highestId);
    }

    await logCronRun({
      ts: new Date().toISOString(),
      cron: "video-match",
      dryRun,
      elapsedMs: Date.now() - started,
      invoker: req.headers.get("x-vercel-cron")
        ? "vercel-cron"
        : req.headers.get("user-agent") || "unknown",
      candidates: fetched,
      sent: matched + deferredSent + unblockedAndSent,
      skipped:
        skippedAlreadyMatched +
        skippedNoAssignment +
        skippedOld +
        skippedNotReady +
        skippedBlocked +
        heldDuplicate,
      errors,
    });

    return NextResponse.json(
      {
        ok: true,
        dryRun,
        elapsedMs: Date.now() - started,
        siteId,
        lastSeenIdBefore: lastSeenId,
        lastSeenIdAfter: highestId,
        fetched,
        matched,
        savedPending,
        deferredSent,
        skippedBlocked,
        unblockedAndSent,
        vt3Linked,
        vt3DisabledFlips,
        skippedOld,
        skippedAlreadyMatched,
        skippedNoAssignment,
        skippedNotReady,
        heldDuplicate,
        errors,
        matches,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[video-match] error:", err);
    await logCronRun({
      ts: new Date().toISOString(),
      cron: "video-match",
      dryRun,
      elapsedMs: Date.now() - started,
      invoker: req.headers.get("x-vercel-cron")
        ? "vercel-cron"
        : req.headers.get("user-agent") || "unknown",
      candidates: fetched,
      sent: matched,
      skipped:
        skippedAlreadyMatched + skippedNoAssignment + skippedOld + skippedNotReady + heldDuplicate,
      errors,
      fatalError: err instanceof Error ? err.message : "cron error",
    });
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "cron error", matched, errors },
      { status: 500 },
    );
  } finally {
    if (!dryRun) {
      try {
        await redis.del(CRON_LOCK_KEY);
      } catch {
        /* best-effort */
      }
    }
  }
}
