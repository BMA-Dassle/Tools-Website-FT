import redis from "@/lib/redis";
import {
  getMatchByVideoCode,
  saveVideoMatch,
  updateVideoMatch,
  isVideoReadyForNotify,
  type VideoMatch,
} from "@/lib/video-match";
import { getAssignmentAtTime } from "@/lib/camera-assign";
import { getBlockState } from "@/lib/video-block";
import { notifyVideoReady, cameraHistoryEntryFromMatch } from "@/lib/video-notify";
import { setVideoDisabled, linkCustomerEmail } from "@/lib/vt3";

/**
 * Per-video event processor — the "what should happen for this video"
 * pipeline shared by the polling cron at /api/cron/video-match AND the
 * push-driven webhook at /api/webhooks/vt3-video-event.
 *
 * Both call this function with the same event semantics. Whichever path
 * fires first wins via SET-NX guards on the underlying state keys:
 *
 *   - saveVideoMatch uses SET NX on `video-match:by-code:{code}` →
 *     concurrent first-sighting calls race; only one creates the record
 *   - fireNotify guard uses SET NX on `notify-fired:{code}` (30s TTL) →
 *     concurrent ready-to-fire calls race; only one sends the SMS
 *
 * The OTHER caller sees "already done" state (notifySmsOk set,
 * pendingNotify cleared, etc.) and short-circuits naturally. No
 * duplicates, no missed notifications.
 *
 * Source tagging: opts.source identifies the caller ("cron"|"webhook")
 * so we can analyze which path is actually delivering value over time.
 *
 * NOT covered by this processor (cron retains these):
 *   - lastSeenId cursor management — cron-only, not needed for push
 *   - dryRun support — cron-only
 *   - overlay-only updates (viewed/purchased fields) when no notify
 *     is fired — cron handles this in its always-run overlay pass
 *   - block-state mirror sync to VT3 disabled flag — cron-only for now
 *
 * The webhook calls this for the LATENCY-CRITICAL paths: deferred
 * notify when sample becomes ready, and new-match creation +
 * immediate notify when a video first appears.
 */

const NOTIFY_LOCK_TTL = 30; // sec
const NOTIFY_LOCK_KEY = (code: string) => `notify-fired:${code}`;

export type ProcessSource = "cron" | "webhook" | "manual";

export type ProcessDecision =
  // PATH 1 — existing match
  | "skip-blocked"
  | "skip-already-notified"
  | "skip-not-ready-yet"
  | "fired-deferred-notify"
  | "lost-notify-race"
  // PATH 2 — new match
  | "skip-no-camera-id"
  | "skip-no-assignment"
  | "lost-create-race"
  | "saved-pending"
  | "saved-and-blocked"
  | "saved-and-notified";

export interface ProcessResult {
  decision: ProcessDecision;
  source: ProcessSource;
  videoCode: string;
  /** Set when fire happened (saved-and-notified or fired-deferred-notify). */
  notifyFired?: boolean;
  /** Set when SMS was attempted as part of this fire. */
  notifySmsOk?: boolean;
  /** Set when email was attempted. */
  notifyEmailOk?: boolean;
  /** Notes / debug context. */
  notes?: string;
}

/**
 * Normalized "video event" the processor accepts. Cron passes its
 * `Vt3Video` records; webhook normalizes the SSE payload into this
 * shape (mainly camelCase → snake_case for `created_at`).
 *
 * For `sample-uploaded` events VT3 sends a compact payload without
 * status / createdAt / sampleUploadTime. Pass `forceReady: true` so
 * the processor treats it as ready without those fields.
 */
export interface VideoEventInput {
  id: number;
  code: string;
  status?: string | null;
  sampleUploadTime?: string | null;
  uploadTime?: string | null;
  duration?: number;
  thumbnailUrl?: string;
  camera?: number | null;
  system?: { name?: string; id?: number; username?: string };
  /** ISO timestamp from VT3. Snake_case to match the cron's existing
   *  `Vt3Video` shape. */
  created_at?: string;
  /** When true, treat as ready-to-notify regardless of status /
   *  sampleUploadTime fields. Used by webhook for sample-uploaded
   *  events that don't carry status info. */
  forceReady?: boolean;
}

export interface ProcessOpts {
  source: ProcessSource;
  /** When true, log decision but skip Redis writes / notify sends.
   *  Used by cron's dry-run mode. */
  dryRun?: boolean;
}

/**
 * Best-effort: try to acquire the notify-fired NX lock. Returns true
 * if THIS caller should fire; false if someone else already did
 * (or just claimed the right to).
 */
async function acquireNotifyLock(code: string, source: ProcessSource): Promise<boolean> {
  try {
    const won = await redis.set(
      NOTIFY_LOCK_KEY(code),
      `${source}:${Date.now()}`,
      "EX",
      NOTIFY_LOCK_TTL,
      "NX",
    );
    return won === "OK";
  } catch {
    // Redis hiccup — fall back to letting both fire and rely on
    // notifySmsSentAt idempotency at the record level.
    return true;
  }
}

/**
 * Fire SMS + email + patch notify fields onto the record. Mirrors the
 * cron's `fireNotify` closure exactly, so behavior is identical
 * regardless of which path triggered.
 */
async function doFireNotify(record: VideoMatch): Promise<{
  smsOk?: boolean;
  emailOk?: boolean;
}> {
  const entry = cameraHistoryEntryFromMatch(record);
  const n = await notifyVideoReady(record, entry);
  const nowIso = new Date().toISOString();
  if (n.sms.attempted) {
    record.notifySmsOk = n.sms.ok;
    record.notifySmsError = n.sms.error;
    record.notifySmsSentTo = n.sms.sentTo;
    record.notifySmsSentAt = nowIso;
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
  if (n.recipient) {
    record.viaGuardian = n.recipient === "guardian" || undefined;
  }
  record.pendingNotify = false;
  await updateVideoMatch(record).catch(() => void 0);
  return { smsOk: n.sms.attempted ? n.sms.ok : undefined, emailOk: n.email.attempted ? n.email.ok : undefined };
}

export async function processVideoEvent(
  event: VideoEventInput,
  opts: ProcessOpts,
): Promise<ProcessResult> {
  const { source, dryRun = false } = opts;
  const code = event.code;
  const ready = event.forceReady === true
    ? true
    : isVideoReadyForNotify({
        status: event.status ?? null,
        sampleUploadTime: event.sampleUploadTime ?? null,
      });

  const existing = await getMatchByVideoCode(code);

  // ── PATH 1 — existing match ──
  if (existing) {
    if (existing.blocked) {
      return { decision: "skip-blocked", source, videoCode: code };
    }
    if (!existing.pendingNotify) {
      // Already fully done — webhook source still gets logged so we
      // can tell who would have done the work first.
      return { decision: "skip-already-notified", source, videoCode: code };
    }
    if (!ready) {
      // Pending and still not ready. Cron handles status-field
      // refresh in its overlay pass; webhook leaves it alone.
      return { decision: "skip-not-ready-yet", source, videoCode: code };
    }

    // Pending → ready. Acquire notify lock.
    if (dryRun) {
      return { decision: "fired-deferred-notify", source, videoCode: code, notes: "dryRun" };
    }
    const won = await acquireNotifyLock(code, source);
    if (!won) {
      return { decision: "lost-notify-race", source, videoCode: code };
    }

    // Push email to VT3 customer profile (best-effort, env-gated).
    if (existing.email && !existing.vt3CustomerLinked) {
      try {
        const linked = await linkCustomerEmail(code, existing.email);
        if (linked) {
          existing.vt3CustomerLinked = true;
          existing.vt3CustomerLinkedEmail = existing.email;
          existing.vt3CustomerLinkedAt = new Date().toISOString();
        }
      } catch (err) {
        console.error(
          `[video-event-processor:${source}] linkCustomerEmail(${code}) failed:`,
          err,
        );
      }
    }
    if (event.status) existing.videoStatus = event.status;
    if (event.sampleUploadTime !== undefined)
      existing.sampleUploadTime = event.sampleUploadTime ?? undefined;
    if (event.uploadTime !== undefined) existing.uploadTime = event.uploadTime ?? undefined;
    const fired = await doFireNotify(existing);
    return {
      decision: "fired-deferred-notify",
      source,
      videoCode: code,
      notifyFired: true,
      notifySmsOk: fired.smsOk,
      notifyEmailOk: fired.emailOk,
    };
  }

  // ── PATH 2 — no existing match. Try to create. ──

  // sample-uploaded events without created_at can't run an
  // assignment lookup. Skip — cron will catch up via its 500-video
  // poll on the next 2-min tick.
  if (!event.created_at) {
    return {
      decision: "skip-no-assignment",
      source,
      videoCode: code,
      notes: "no created_at on event payload, can't run assignment lookup",
    };
  }

  const cameraKey = event.camera != null ? String(event.camera) : "";
  const systemKey = event.system?.name ?? "";
  if (!cameraKey && !systemKey) {
    return { decision: "skip-no-camera-id", source, videoCode: code };
  }

  let assignment = cameraKey ? await getAssignmentAtTime(cameraKey, event.created_at) : null;
  if (!assignment && systemKey) {
    assignment = await getAssignmentAtTime(systemKey, event.created_at);
  }
  if (!assignment) {
    return { decision: "skip-no-assignment", source, videoCode: code };
  }

  const blockState = await getBlockState({
    sessionId: assignment.sessionId,
    personId: assignment.personId,
    videoCode: code,
  });

  if (dryRun) {
    if (blockState.blocked) return { decision: "saved-and-blocked", source, videoCode: code, notes: "dryRun" };
    if (!ready) return { decision: "saved-pending", source, videoCode: code, notes: "dryRun" };
    return { decision: "saved-and-notified", source, videoCode: code, notes: "dryRun" };
  }

  const matchRecord: VideoMatch = {
    sessionId: assignment.sessionId,
    personId: assignment.personId,
    firstName: assignment.firstName,
    lastName: assignment.lastName,
    systemNumber: systemKey,
    cameraNumber: event.camera ?? undefined,
    videoId: event.id,
    videoCode: code,
    customerUrl: `https://vt3.io/?code=${code}`,
    thumbnailUrl: event.thumbnailUrl,
    capturedAt: event.created_at,
    duration: event.duration,
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
    guardian: assignment.guardian ?? undefined,
    pendingNotify: !ready && !blockState.blocked,
    videoStatus: event.status ?? undefined,
    sampleUploadTime: event.sampleUploadTime ?? undefined,
    uploadTime: event.uploadTime ?? undefined,
    blocked: blockState.blocked || undefined,
    blockLevel: blockState.level,
    blockReason: blockState.reason,
    blockedAt: blockState.blocked ? blockState.blockedAt : undefined,
  };

  const saved = await saveVideoMatch(matchRecord);
  if (!saved) {
    // Other path created the record while we were running — they
    // get the work. We exit cleanly. Idempotent.
    return { decision: "lost-create-race", source, videoCode: code };
  }

  if (blockState.blocked) {
    // Saved as blocked — sync VT3 disabled flag, no notify.
    try {
      await setVideoDisabled(code, true);
    } catch (err) {
      console.error(
        `[video-event-processor:${source}] setVideoDisabled(${code},true) failed:`,
        err,
      );
    }
    return { decision: "saved-and-blocked", source, videoCode: code };
  }

  if (!ready) {
    // Saved as pending. Will fire on next event when ready.
    return { decision: "saved-pending", source, videoCode: code };
  }

  // Ready immediately on first sighting — fire now.
  const won = await acquireNotifyLock(code, source);
  if (!won) {
    return {
      decision: "saved-pending",
      source,
      videoCode: code,
      notes: "saved record but notify lost race — other path will fire",
    };
  }

  if (matchRecord.email) {
    try {
      const linked = await linkCustomerEmail(code, matchRecord.email);
      if (linked) {
        matchRecord.vt3CustomerLinked = true;
        matchRecord.vt3CustomerLinkedEmail = matchRecord.email;
        matchRecord.vt3CustomerLinkedAt = new Date().toISOString();
      }
    } catch (err) {
      console.error(
        `[video-event-processor:${source}] linkCustomerEmail(${code}) failed:`,
        err,
      );
    }
  }

  // saveVideoMatch already wrote the record. Patch in linked-email
  // fields (if any) and notify outcomes via doFireNotify.
  if (matchRecord.vt3CustomerLinked) {
    await updateVideoMatch(matchRecord).catch(() => void 0);
  }
  const fired = await doFireNotify(matchRecord);
  return {
    decision: "saved-and-notified",
    source,
    videoCode: code,
    notifyFired: true,
    notifySmsOk: fired.smsOk,
    notifyEmailOk: fired.emailOk,
  };
}

/** Helper: convert webhook payload (camelCase from VT3 SSE) to
 *  the snake_case VideoEventInput the processor expects. */
export function videoEventFromWebhookPayload(
  payload: Record<string, unknown>,
  innerEventType: string,
): VideoEventInput {
  const system = (payload.system as Record<string, unknown> | undefined) ?? undefined;
  return {
    id: typeof payload.id === "number" ? payload.id : 0,
    code: String(payload.code ?? ""),
    status: typeof payload.status === "string" ? payload.status : null,
    sampleUploadTime:
      typeof payload.sampleUploadTime === "string" ? payload.sampleUploadTime : null,
    uploadTime: typeof payload.uploadTime === "string" ? payload.uploadTime : null,
    duration: typeof payload.duration === "number" ? payload.duration : undefined,
    thumbnailUrl: typeof payload.thumbnailUrl === "string" ? payload.thumbnailUrl : undefined,
    camera: typeof payload.camera === "number" ? payload.camera : null,
    system: system
      ? {
          id: typeof system.id === "number" ? system.id : undefined,
          name: typeof system.name === "string" ? system.name : undefined,
          username: typeof system.username === "string" ? system.username : undefined,
        }
      : undefined,
    // Webhook payload uses camelCase createdAt; processor uses snake_case.
    created_at:
      typeof payload.createdAt === "string"
        ? payload.createdAt
        : typeof payload.created_at === "string"
          ? payload.created_at
          : undefined,
    // sample-uploaded events come with no status/createdAt — flag
    // forceReady so the processor treats them as ready without those
    // fields. Match-creation path requires created_at though, so
    // sample-uploaded with no existing match can't create one (cron
    // catches up).
    forceReady: innerEventType === "sample-uploaded",
  };
}
