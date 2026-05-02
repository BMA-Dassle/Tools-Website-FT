import { NextRequest, NextResponse } from "next/server";
import { setVideoDisabled, linkCustomerEmail } from "@/lib/vt3";
import { blockVideo, unblockVideo, getBlockState } from "@/lib/video-block";
import {
  getMatchByVideoCode,
  updateVideoMatch,
  isVideoReadyForNotify,
} from "@/lib/video-match";
import { notifyVideoReady, cameraHistoryEntryFromMatch } from "@/lib/video-notify";

/**
 * POST /api/admin/videos/block
 *
 * Body:
 *   { videoCode: string, block: true|false, reason? }
 *
 * Flow — BLOCK:
 *   1. Write video-level block key
 *   2. VT3 PUT disabled:true so vt3.io link stops playing
 *   3. Patch match record's blocked mirror (if match exists)
 *
 * Flow — UNBLOCK:
 *   1. Delete video-level block key
 *   2. Re-resolve block state — if heat or person still blocks, short-
 *      circuit (the record stays blocked, VT3 stays disabled)
 *   3. Otherwise: VT3 PUT disabled:false
 *   4. Patch match record, clearing blocked mirror
 *   5. If the match was never notified AND VT3 is ready, push
 *      customer email to VT3 + fire notify inline (don't wait for next
 *      cron tick)
 *
 * Auth: middleware gates /api/admin/videos/* on ADMIN_CAMERA_TOKEN.
 */

// Ready/not-ready check uses the shared allowlist — see
// lib/video-match.ts:VIDEO_READY_STATUSES. Anything not on that
// allowlist (TRANSFERRING / SAMPLING / PROCESSING / ENCODING / etc.)
// holds, and the next cron tick fires notify when VT3 transitions.

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const videoCode = typeof body?.videoCode === "string" ? body.videoCode.trim() : "";
    const block = !!body?.block;
    const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : undefined;

    if (!videoCode) {
      return NextResponse.json({ error: "videoCode required" }, { status: 400 });
    }

    const existing = await getMatchByVideoCode(videoCode);

    if (block) {
      await blockVideo(videoCode, { reason });
      // Best-effort VT3 disable — staff may block a video whose match
      // record hasn't been created yet (unmatched row in admin).
      let vt3Ok = false;
      try {
        await setVideoDisabled(videoCode, true);
        vt3Ok = true;
      } catch (err) {
        console.error(`[videos/block] setVideoDisabled(${videoCode},true) failed:`, err);
      }

      if (existing) {
        existing.blocked = true;
        existing.blockLevel = "video";
        existing.blockReason = reason;
        existing.blockedAt = new Date().toISOString();
        // If the match was sitting as pending-notify, flip that off —
        // blocked records don't notify.
        existing.pendingNotify = false;
        await updateVideoMatch(existing).catch(() => void 0);
      }

      return NextResponse.json({ ok: true, block: true, vt3Ok });
    }

    // UNBLOCK path
    await unblockVideo(videoCode);

    // Re-resolve — session / person blocks may still apply.
    let stillBlocked = false;
    if (existing) {
      const fresh = await getBlockState({
        sessionId: existing.sessionId,
        personId: existing.personId,
        videoCode,
      });
      stillBlocked = fresh.blocked;
    }

    let vt3Ok = false;
    if (!stillBlocked) {
      try {
        await setVideoDisabled(videoCode, false);
        vt3Ok = true;
      } catch (err) {
        console.error(`[videos/block] setVideoDisabled(${videoCode},false) failed:`, err);
      }
    }

    let notified = false;
    let vt3Linked = false;
    if (existing && !stillBlocked) {
      existing.blocked = undefined;
      existing.blockLevel = undefined;
      existing.blockReason = undefined;
      existing.blockedAt = undefined;

      const neverNotified = !existing.notifySmsSentAt && !existing.notifyEmailSentAt;
      const vt3Ready = isVideoReadyForNotify(existing.videoStatus);

      if (neverNotified && vt3Ready) {
        // Push email to VT3 customer profile first, then fire notify.
        if (existing.email && !existing.vt3CustomerLinked) {
          try {
            const linked = await linkCustomerEmail(videoCode, existing.email);
            if (linked) {
              existing.vt3CustomerLinked = true;
              existing.vt3CustomerLinkedEmail = existing.email;
              existing.vt3CustomerLinkedAt = new Date().toISOString();
              vt3Linked = true;
            }
          } catch (err) {
            console.error(`[videos/block] linkCustomerEmail(${videoCode}) failed:`, err);
          }
        }
        try {
          const n = await notifyVideoReady(existing, cameraHistoryEntryFromMatch(existing));
          const ts = new Date().toISOString();
          if (n.sms.attempted) {
            existing.notifySmsOk = n.sms.ok;
            existing.notifySmsError = n.sms.error;
            existing.notifySmsSentTo = n.sms.sentTo;
            existing.notifySmsSentAt = ts;
          }
          if (n.email.attempted) {
            existing.notifyEmailOk = n.email.ok;
            existing.notifyEmailError = n.email.error;
            existing.notifyEmailSentTo = n.email.sentTo;
            existing.notifyEmailSentAt = ts;
          }
          existing.pendingNotify = false;
          notified = true;
        } catch (err) {
          console.error(`[videos/block] inline notify failed for ${videoCode}:`, err);
        }
      } else if (neverNotified && !vt3Ready) {
        // Not ready yet — cron's overlay pass will fire once VT3 flips.
        existing.pendingNotify = true;
      }

      await updateVideoMatch(existing).catch(() => void 0);
    }

    return NextResponse.json({
      ok: true,
      block: false,
      vt3Ok,
      stillBlocked,
      notified,
      vt3Linked,
    });
  } catch (err) {
    console.error("[videos/block]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "block failed" },
      { status: 500 },
    );
  }
}
