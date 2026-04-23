import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { listRecentVideos } from "@/lib/vt3";
import { getAssignmentAtTime } from "@/lib/camera-assign";
import {
  saveVideoMatch,
  updateVideoMatch,
  hasVideoBeenMatched,
  getLastSeenVideoId,
  setLastSeenVideoId,
  type VideoMatch,
} from "@/lib/video-match";
import { notifyVideoReady } from "@/lib/video-notify";
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
  let matched = 0;
  let errors = 0;
  const matches: { videoCode: string; cameraNumber: string; racer: string; sessionId: string | number }[] = [];

  try {
    const siteId = parseInt(process.env.VT3_SITE_ID || "992", 10);

    const [videos, lastSeenId] = await Promise.all([
      listRecentVideos({ siteId, limit: 50 }),
      getLastSeenVideoId(),
    ]);

    let highestId = lastSeenId;

    for (const v of videos) {
      fetched++;
      if (v.id <= lastSeenId) {
        skippedOld++;
        continue;
      }
      if (v.id > highestId) highestId = v.id;

      const cameraNumber = v.system?.name || "";
      if (!cameraNumber) {
        // Can't match — no camera number on the record.
        skippedNoAssignment++;
        continue;
      }

      // Already matched by a previous run? (sentinel check)
      if (await hasVideoBeenMatched(v.code)) {
        skippedAlreadyMatched++;
        continue;
      }

      // Time-aware lookup: who was this camera assigned to when the
      // video was captured?
      const assignment = await getAssignmentAtTime(cameraNumber, v.created_at);
      if (!assignment) {
        skippedNoAssignment++;
        continue;
      }

      if (dryRun) {
        matched++;
        matches.push({
          videoCode: v.code,
          cameraNumber,
          racer: `${assignment.firstName} ${assignment.lastName}`,
          sessionId: assignment.sessionId,
        });
        continue;
      }

      try {
        const matchRecord: VideoMatch = {
          sessionId: assignment.sessionId,
          personId: assignment.personId,
          firstName: assignment.firstName,
          lastName: assignment.lastName,
          cameraNumber,                 // kart / system.name (e.g. "913")
          cameraId: v.camera,           // vt3's hardware camera (e.g. 20)
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
          // Snapshot contact so the admin-resend endpoint doesn't need to
          // re-walk the camera-history set.
          email: assignment.email,
          phone: assignment.phone,
          mobilePhone: assignment.mobilePhone,
          homePhone: assignment.homePhone,
          acceptSmsCommercial: assignment.acceptSmsCommercial,
        };
        const saved = await saveVideoMatch(matchRecord);
        if (saved) {
          matched++;
          matches.push({
            videoCode: v.code,
            cameraNumber,
            racer: `${assignment.firstName} ${assignment.lastName}`,
            sessionId: assignment.sessionId,
          });
          // Notify the racer — SMS (consent-gated) + email. Best-effort,
          // non-blocking. Persist the notify outcome back onto the match
          // record so the admin UI can see what went out.
          try {
            const n = await notifyVideoReady(matchRecord, assignment);
            const nowIso = new Date().toISOString();
            if (n.sms.attempted) {
              matchRecord.notifySmsOk = n.sms.ok;
              matchRecord.notifySmsError = n.sms.error;
              matchRecord.notifySmsSentTo = n.sms.sentTo;
              matchRecord.notifySmsSentAt = nowIso;
            }
            if (n.email.attempted) {
              matchRecord.notifyEmailOk = n.email.ok;
              matchRecord.notifyEmailError = n.email.error;
              matchRecord.notifyEmailSentTo = n.email.sentTo;
              matchRecord.notifyEmailSentAt = nowIso;
            }
            // Patch the match record in place with the notify status.
            // updateVideoMatch bypasses the NX sentinel which has
            // already fired for this video.
            await updateVideoMatch(matchRecord).catch(() => void 0);
          } catch (err) {
            console.error(`[video-match] notify error for code=${v.code}:`, err);
          }
        } else {
          // Another cron ran faster — treat as already matched.
          skippedAlreadyMatched++;
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
      skipped: skippedAlreadyMatched + skippedNoAssignment + skippedOld,
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
        skippedOld,
        skippedAlreadyMatched,
        skippedNoAssignment,
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
      skipped: skippedAlreadyMatched + skippedNoAssignment + skippedOld,
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
