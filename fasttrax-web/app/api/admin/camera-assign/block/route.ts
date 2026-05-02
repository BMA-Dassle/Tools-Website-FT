import { NextRequest, NextResponse } from "next/server";
import {
  blockSession,
  unblockSession,
  blockPerson,
  unblockPerson,
  overrideUnblockPerson,
  getBlockState,
} from "@/lib/video-block";
import {
  getMatch,
  updateVideoMatch,
  isVideoReadyForNotify,
  type VideoMatch,
} from "@/lib/video-match";
import { setVideoDisabled, linkCustomerEmail } from "@/lib/vt3";
import { notifyVideoReady, cameraHistoryEntryFromMatch } from "@/lib/video-notify";

/**
 * POST /api/admin/camera-assign/block
 *
 * Body:
 *   { scope: "session", sessionId, block: true|false, reason?, personIds?: (string|number)[] }
 *     → block/unblock every racer in this heat. `personIds` is the
 *       participant list so we can instantly sync VT3 + match records
 *       for videos that have already arrived (no waiting 2 min for the
 *       next cron tick).
 *   { scope: "person",  sessionId, personId, block: true|false, reason?, override? }
 *     → block one racer. `override: true` with `block: false` writes an
 *       explicit unblock marker that beats a session-level block (use
 *       when the heat is blocked but staff wants to release ONE racer).
 *
 * This endpoint writes the Redis block key AND — for any matched
 * videos already in Redis for the targeted (session, personId) pairs
 * — calls VT3 to flip `disabled` and patches the VideoMatch `blocked`
 * mirror. That matches the /api/admin/videos/block endpoint's
 * post-match "immediate" semantics so staff never has to wait for the
 * cron.
 *
 * Unblock flow: re-resolves block state per-video (in case video- or
 * person-level blocks still apply) before un-disabling VT3. Fires the
 * inline "backfill" notify on newly-eligible matches (never notified
 * + VT3 ready).
 *
 * Auth: middleware.ts gates /api/admin/camera-assign/* on ADMIN_CAMERA_TOKEN.
 */

// VT3 ready/not-ready uses the shared allowlist —
// see lib/video-match.ts:VIDEO_READY_STATUSES. Anything not on the
// allowlist (including the ENCODING state that recently snuck through
// our prior blocklist) holds; the next cron tick fires inline notify
// once VT3 transitions.

/**
 * Walk a list of (sessionId, personId) pairs, fetch the match record
 * for each if any, and apply the block flip to VT3 + Redis.
 *
 * `nowBlocked` indicates the desired end-state. On unblock we still
 * re-resolve block state against the OTHER layers (video-level,
 * person-level that wasn't the one we just cleared) — if anything
 * else blocks the video we keep VT3 disabled.
 */
async function applyToExistingMatches(
  pairs: Array<{ sessionId: string | number; personId: string | number }>,
  nowBlocked: boolean,
  ctx: { reason?: string },
): Promise<{
  touched: number;
  vt3Flips: number;
  notified: number;
  vt3Linked: number;
  errors: string[];
}> {
  const result = { touched: 0, vt3Flips: 0, notified: 0, vt3Linked: 0, errors: [] as string[] };

  for (const { sessionId, personId } of pairs) {
    let match: VideoMatch | null = null;
    try {
      match = await getMatch(sessionId, personId);
    } catch (err) {
      result.errors.push(`getMatch(${sessionId},${personId}): ${err instanceof Error ? err.message : "unknown"}`);
      continue;
    }
    if (!match) continue; // no video matched yet — cron handles when it arrives
    result.touched++;

    if (nowBlocked) {
      // Flip VT3 disabled + update mirror. Best-effort VT3.
      try {
        await setVideoDisabled(match.videoCode, true);
        result.vt3Flips++;
      } catch (err) {
        result.errors.push(`setVideoDisabled(${match.videoCode},true): ${err instanceof Error ? err.message : "err"}`);
      }
      match.blocked = true;
      match.blockLevel = pairs.length > 1 ? "session" : "person";
      match.blockReason = ctx.reason;
      match.blockedAt = new Date().toISOString();
      match.pendingNotify = false;
      await updateVideoMatch(match).catch(() => void 0);
    } else {
      // Unblocking. Are OTHER layers still blocking this video?
      let stillBlocked = false;
      try {
        const fresh = await getBlockState({ sessionId, personId, videoCode: match.videoCode });
        stillBlocked = fresh.blocked;
      } catch (err) {
        result.errors.push(`getBlockState(${match.videoCode}): ${err instanceof Error ? err.message : "err"}`);
      }
      if (!stillBlocked) {
        try {
          await setVideoDisabled(match.videoCode, false);
          result.vt3Flips++;
        } catch (err) {
          result.errors.push(`setVideoDisabled(${match.videoCode},false): ${err instanceof Error ? err.message : "err"}`);
        }
        match.blocked = undefined;
        match.blockLevel = undefined;
        match.blockReason = undefined;
        match.blockedAt = undefined;

        // Backfill notify if never sent + VT3 ready.
        const neverNotified = !match.notifySmsSentAt && !match.notifyEmailSentAt;
        const vt3Ready = isVideoReadyForNotify(match.videoStatus);
        if (neverNotified && vt3Ready) {
          if (match.email && !match.vt3CustomerLinked) {
            try {
              const linked = await linkCustomerEmail(match.videoCode, match.email);
              if (linked) {
                match.vt3CustomerLinked = true;
                match.vt3CustomerLinkedEmail = match.email;
                match.vt3CustomerLinkedAt = new Date().toISOString();
                result.vt3Linked++;
              }
            } catch (err) {
              result.errors.push(`linkCustomerEmail(${match.videoCode}): ${err instanceof Error ? err.message : "err"}`);
            }
          }
          try {
            const n = await notifyVideoReady(match, cameraHistoryEntryFromMatch(match));
            const ts = new Date().toISOString();
            if (n.sms.attempted) {
              match.notifySmsOk = n.sms.ok;
              match.notifySmsError = n.sms.error;
              match.notifySmsSentTo = n.sms.sentTo;
              match.notifySmsSentAt = ts;
            }
            if (n.email.attempted) {
              match.notifyEmailOk = n.email.ok;
              match.notifyEmailError = n.email.error;
              match.notifyEmailSentTo = n.email.sentTo;
              match.notifyEmailSentAt = ts;
            }
            match.pendingNotify = false;
            result.notified++;
          } catch (err) {
            result.errors.push(`notifyVideoReady(${match.videoCode}): ${err instanceof Error ? err.message : "err"}`);
          }
        } else if (neverNotified && !vt3Ready) {
          // Not ready yet — let the cron pick it up later.
          match.pendingNotify = true;
        }
        await updateVideoMatch(match).catch(() => void 0);
      }
    }
  }
  return result;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const scope = body?.scope;
    const sessionId = body?.sessionId;
    const personId = body?.personId;
    const block = !!body?.block;
    const override = !!body?.override;
    const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : undefined;
    const personIdsRaw: unknown = body?.personIds;
    const personIds: Array<string | number> = Array.isArray(personIdsRaw)
      ? personIdsRaw.filter((x): x is string | number => typeof x === "string" || typeof x === "number")
      : [];

    if (!sessionId) {
      return NextResponse.json({ error: "sessionId required" }, { status: 400 });
    }

    if (scope === "session") {
      if (block) {
        await blockSession(sessionId, { reason });
      } else {
        await unblockSession(sessionId);
      }
      // Instant-apply to any matches already in Redis for this session.
      // The client sends `personIds` (from the roster) so we can target
      // the matches without SCANning Redis.
      const pairs = personIds.map((pid) => ({ sessionId, personId: pid }));
      const sideEffects = pairs.length > 0
        ? await applyToExistingMatches(pairs, block, { reason })
        : { touched: 0, vt3Flips: 0, notified: 0, vt3Linked: 0, errors: [] };
      return NextResponse.json({ ok: true, scope, block, ...sideEffects });
    }

    if (scope === "person") {
      if (!personId) {
        return NextResponse.json({ error: "personId required for person scope" }, { status: 400 });
      }
      if (block) {
        await blockPerson(sessionId, personId, { reason });
      } else if (override) {
        // "Heat is blocked, release this one racer" marker.
        await overrideUnblockPerson(sessionId, personId, { reason });
      } else {
        await unblockPerson(sessionId, personId);
      }
      // Instant-apply to this one racer's match if it exists. Override
      // counts as an "unblock" for the existing match (since the racer
      // is being released from the heat block).
      const nowBlockedForMatch = block && !override;
      const sideEffects = await applyToExistingMatches(
        [{ sessionId, personId }],
        nowBlockedForMatch,
        { reason },
      );
      return NextResponse.json({ ok: true, scope, block, override, ...sideEffects });
    }

    return NextResponse.json({ error: "scope must be 'session' or 'person'" }, { status: 400 });
  } catch (err) {
    console.error("[camera-assign/block]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "block failed" },
      { status: 500 },
    );
  }
}
