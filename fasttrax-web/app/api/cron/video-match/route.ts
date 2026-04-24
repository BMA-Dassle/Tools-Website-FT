import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { listRecentVideos, type Vt3Video } from "@/lib/vt3";
import { getAssignmentAtTime } from "@/lib/camera-assign";
import {
  saveVideoMatch,
  updateVideoMatch,
  getMatchByVideoCode,
  getLastSeenVideoId,
  setLastSeenVideoId,
  type VideoMatch,
} from "@/lib/video-match";
import { notifyVideoReady, cameraHistoryEntryFromMatch } from "@/lib/video-notify";
import { logCronRun } from "@/lib/sms-log";

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
 *   4. Look up the camera-history sorted set at the video's
 *      `created_at` timestamp — returns the assignment that was live
 *      for this camera at capture time. Critical for multi-heat days
 *      where the same kart runs two or three different racers.
 *   5. If an assignment is found, persist the match
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
    !!v.hasVideoPageImpression ||
    !!v.hasMediaCentreImpression ||
    !!v.firstImpressionAt;
  const unlockedAt = v.unlockTime || undefined;
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
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const started = Date.now();

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
  let skippedNotReady = 0;       // match row exists + still waiting on VT3
  let savedPending = 0;           // NEW match, saved with pendingNotify=true
  let deferredSent = 0;           // pending match turned ready, notify fired on this tick
  let matched = 0;                // new match + immediate notify (VT3 already ready)
  let errors = 0;

  /**
   * VT3 video status values seen in the wild:
   *   TRANSFERRING       — upload in progress, preview NOT viewable yet
   *   SAMPLING           — generating preview, still not viewable by staff
   *   TRANSFERRED        — upload complete
   *   PENDING_ACTIVATION — activation pending but preview MP4 IS viewable
   *   UPLOADED / ACTIVE  — fully available
   *
   * We hold off notifying racers until the status reaches a state where
   * tapping the link in the SMS actually plays something. Staff reported
   * a race condition where texts were landing while vt3.io/?code=X was
   * still showing 'processing'.
   *
   * Blocklist of known "too early" statuses; everything else passes.
   * Using a blocklist (not allowlist) so VT3 adding a new later state
   * doesn't silently block the cron.
   */
  const NOT_READY_STATUSES = new Set([
    "TRANSFERRING",
    "SAMPLING",
    "PENDING_UPLOAD",
    "PROCESSING",
  ]);
  const matches: { videoCode: string; systemNumber: string; cameraNumber?: number; racer: string; sessionId: string | number }[] = [];

  try {
    const siteId = parseInt(process.env.VT3_SITE_ID || "992", 10);

    // Pull the newest 200 (up from 50) so a multi-minute backlog (e.g. a
    // restart after the match logic changed) catches up in a single
    // cron fire instead of dripping across 4+ runs.
    const [videos, lastSeenId] = await Promise.all([
      listRecentVideos({ siteId, limit: 200 }),
      getLastSeenVideoId(),
    ]);

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
        }
        if (n.email.attempted) {
          record.notifyEmailOk = n.email.ok;
          record.notifyEmailError = n.email.error;
          record.notifyEmailSentTo = n.email.sentTo;
          record.notifyEmailSentAt = nowIso;
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
      // regardless of cursor position or readiness state. Videos
      // matched days ago still need their "viewed" / "purchased" chips
      // to tick forward each time a racer opens the share link.
      //
      // Cheap: at most `videos.length` GETs/tick (≤200), and we only
      // SET when a field actually changed.
      const overlay = extractOverlay(v);
      const existing = await getMatchByVideoCode(v.code);
      if (existing) {
        const changed = overlayDiffers(existing, overlay);
        // Mutate in place AFTER the diff check — any subsequent write
        // in this iteration (deferred-notify's `updateVideoMatch(existing)`,
        // the save-path fallback, etc.) then carries the overlay fields
        // forward without clobbering.
        Object.assign(existing, overlay);
        if (changed && !dryRun) {
          try {
            await updateVideoMatch(existing);
          } catch (err) {
            console.error(`[video-match] overlay update failed for code=${v.code}:`, err);
          }
        }
      }

      if (v.id <= lastSeenId) {
        skippedOld++;
        continue;
      }

      const notReady = !!v.status && NOT_READY_STATUSES.has(v.status);

      // -----------------------------------------------------------------
      // PATH 1: existing match (prior cron run already created a record).
      // If it's pending-notify and the video has now transitioned to a
      // preview-ready status, fire the notification now + mark ready.
      // Otherwise skip.
      // -----------------------------------------------------------------
      if (existing) {
        if (!existing.pendingNotify) {
          // Fully done in a prior run.
          if (v.id > highestId) highestId = v.id;
          skippedAlreadyMatched++;
          continue;
        }
        // Pending match. Is it ready yet?
        if (notReady) {
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
        existing.videoStatus = v.status;
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
      // PATH 2: no existing record. Try to match by camera + save. If VT3
      // isn't ready, save with pendingNotify=true (admin sees the row
      // now, racer gets the SMS once VT3 transitions). If ready, notify
      // immediately.
      // -----------------------------------------------------------------
      //
      // Key the match on video.camera (NFC-scanned hardware id). Fallback
      // to video.system.name for legacy records stored that way.
      const cameraKey = v.camera != null ? String(v.camera) : "";
      const systemFallbackKey = v.system?.name || "";
      if (!cameraKey && !systemFallbackKey) {
        skippedNoAssignment++;
        continue;
      }

      // Time-aware: who was this camera assigned to when the video was
      // captured?
      let assignment = cameraKey ? await getAssignmentAtTime(cameraKey, v.created_at) : null;
      if (!assignment && systemFallbackKey) {
        assignment = await getAssignmentAtTime(systemFallbackKey, v.created_at);
      }
      if (!assignment) {
        if (v.id > highestId) highestId = v.id;
        skippedNoAssignment++;
        continue;
      }

      if (dryRun) {
        matches.push({
          videoCode: v.code,
          systemNumber: systemFallbackKey,
          cameraNumber: v.camera,
          racer: `${assignment.firstName} ${assignment.lastName}`,
          sessionId: assignment.sessionId,
        });
        if (notReady) savedPending++; else matched++;
        continue;
      }

      try {
        const matchRecord: VideoMatch = {
          sessionId: assignment.sessionId,
          personId: assignment.personId,
          firstName: assignment.firstName,
          lastName: assignment.lastName,
          systemNumber: systemFallbackKey,
          cameraNumber: v.camera,
          videoId: v.id,
          videoCode: v.code,
          customerUrl: `https://vt3.io/?code=${v.code}`,
          thumbnailUrl: v.thumbnailUrl,
          capturedAt: v.created_at,
          duration: v.duration,
          matchedAt: new Date().toISOString(),
          sessionName: assignment.sessionName,
          scheduledStart: assignment.scheduledStart,
          track: assignment.track,
          raceType: assignment.raceType,
          heatNumber: assignment.heatNumber,
          email: assignment.email,
          phone: assignment.phone,
          mobilePhone: assignment.mobilePhone,
          homePhone: assignment.homePhone,
          acceptSmsCommercial: assignment.acceptSmsCommercial,
          pendingNotify: notReady,
          videoStatus: v.status,
          ...overlay,
        };
        const saved = await saveVideoMatch(matchRecord);
        if (!saved) {
          skippedAlreadyMatched++;
          continue;
        }
        matches.push({
          videoCode: v.code,
          systemNumber: systemFallbackKey,
          cameraNumber: v.camera,
          racer: `${assignment.firstName} ${assignment.lastName}`,
          sessionId: assignment.sessionId,
        });
        if (notReady) {
          // Saved as pending. Admin will see the row; notify fires on
          // the next tick once VT3 says ready. Do NOT advance highestId
          // so we revisit this video.
          savedPending++;
        } else {
          // VT3 is ready now — fire notify immediately, mark record
          // final, advance cursor.
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
      invoker: req.headers.get("x-vercel-cron") ? "vercel-cron" : (req.headers.get("user-agent") || "unknown"),
      candidates: fetched,
      sent: matched,
      skipped: skippedAlreadyMatched + skippedNoAssignment + skippedOld + skippedNotReady,
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
        skippedOld,
        skippedAlreadyMatched,
        skippedNoAssignment,
        skippedNotReady,
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
      invoker: req.headers.get("x-vercel-cron") ? "vercel-cron" : (req.headers.get("user-agent") || "unknown"),
      candidates: fetched,
      sent: matched,
      skipped: skippedAlreadyMatched + skippedNoAssignment + skippedOld + skippedNotReady,
      errors,
      fatalError: err instanceof Error ? err.message : "cron error",
    });
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "cron error", matched, errors },
      { status: 500 },
    );
  } finally {
    if (!dryRun) {
      try { await redis.del(CRON_LOCK_KEY); } catch { /* best-effort */ }
    }
  }
}
