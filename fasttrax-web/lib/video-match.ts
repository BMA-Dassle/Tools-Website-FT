import redis from "@/lib/redis";
import type { GuardianContact } from "@/lib/participant-contact";

/**
 * Racer → video links produced by the video-match cron.
 *
 * When the cron finds a vt3.io video whose camera was bound to a
 * racer in the camera-assign admin, it calls `saveVideoMatch()` to
 * persist the link. Downstream consumers (e-ticket page, post-race
 * SMS, admin UI) can then use `getVideoForRacer()` to display the
 * video URL.
 *
 * Keys:
 *   video-match:{sessionId}:{personId}  — the match record
 *   video-match:by-code:{videoCode}     — sentinel preventing
 *                                          re-match of the same video
 *                                          across cron runs (idempotency)
 *   vt3:last-seen-id                    — highest video id processed,
 *                                          used by the cron to trim
 *                                          the next /videos call
 */

const TTL_DAYS = 90;
const TTL_SECONDS = 60 * 60 * 24 * TTL_DAYS;

export interface VideoMatch {
  sessionId: string | number;
  personId: string | number;
  firstName: string;
  lastName: string;
  /** System / base-station ID — e.g. "913". Where the camera was
   *  docked / plugged in. Matches video.system.name on vt3.io. This
   *  is what the NFC scan picks up in the camera-assign tool. */
  systemNumber: string;
  /** Hardware camera number — vt3's internal camera id (e.g. 20),
   *  different from the system number. Populated from video.camera. */
  cameraNumber?: number;
  videoId: number;
  videoCode: string;
  customerUrl: string;          // https://vt3.io/?code={code}
  shortUrl?: string;            // our /s/{code} redirect so clicks track
  thumbnailUrl?: string;
  capturedAt: string;           // video.created_at (ISO)
  duration?: number;            // seconds
  matchedAt: string;            // when the cron made the link (ISO)
  sessionName?: string;
  scheduledStart?: string;
  track?: string;
  raceType?: string;
  heatNumber?: number;
  /** Snapshot of contact info at match time — duplicated from the
   *  camera-history entry so the admin-resend endpoint doesn't need
   *  to walk back to the history set. */
  email?: string;
  phone?: string;                // canonical or raw — use canonicalizePhone
  mobilePhone?: string;
  homePhone?: string;
  acceptSmsCommercial?: boolean;
  /** True when the SMS / email was routed to the guardian instead of
   *  the racer (minor with no usable own contact). The notify path
   *  sets this; the videos admin board surfaces a "↻ guardian" chip
   *  next to the green sms/email status. */
  viaGuardian?: boolean;
  /** Guardian / parent contact — populated for minor racers by
   *  Pandora's participant payload. The video-notify path falls
   *  back to this when the racer themselves has no usable contact;
   *  body is reframed as "Video ready for {racerFirstName}" so the
   *  guardian knows whose video this is. Shape matches the canonical
   *  GuardianContact in lib/participant-contact.ts. */
  guardian?: GuardianContact | null;
  /** Notification status set by the cron after SMS/email attempts. */
  notifySmsOk?: boolean;
  notifySmsError?: string;
  notifySmsSentTo?: string;
  notifySmsSentAt?: string;
  /** Vox message id captured at send time. Used by the SMS-status
   *  webhook (/api/sms-webhook/vox) to look up THIS video record
   *  (via the `video:msgid:{voxId}` index) and update the carrier
   *  delivery status — without it, the videos admin would only
   *  ever see "send-time outcome" not "actual handset delivery". */
  notifySmsProviderMessageId?: string;
  /** Carrier-DLR delivery state from the Vox webhook. `delivered`
   *  is the strong positive (carrier confirmed handset receipt);
   *  `undelivered` / `failed` mean the carrier rejected. Drives
   *  the green-vs-yellow pill on the videos admin so staff see
   *  ACTUAL delivery, not just "Vox accepted". */
  notifySmsDeliveryStatus?: "delivered" | "undelivered" | "failed" | "sent" | "queued";
  notifySmsDeliveryUpdatedAt?: string;
  notifySmsDeliveryErrorCode?: string;
  notifyEmailOk?: boolean;
  notifyEmailError?: string;
  notifyEmailSentTo?: string;
  notifyEmailSentAt?: string;
  /** True when the match was saved but SMS/email are held off because
   *  VT3 hasn't finished sampling the video yet (status is one of
   *  TRANSFERRING/SAMPLING/PROCESSING). Once the next cron tick sees
   *  the status flipped to PENDING_ACTIVATION or later, notify fires
   *  and this flag goes false. */
  pendingNotify?: boolean;
  /** Last VT3 status observed for the video (e.g. 'TRANSFERRING',
   *  'PENDING_ACTIVATION'). Surfaced in the admin UI so staff can
   *  see where in the upload pipeline a pending row sits. */
  videoStatus?: string;
  /** VT3 impression / purchase overlay — populated by the video-match
   *  cron every tick from vt3's /videos feed, even for videos past the
   *  lastSeenId cursor. Lets the admin UI answer "did the racer watch
   *  this?" / "did they buy it?" without us calling VT3 from the
   *  browser (which would bump impression counters and skew metrics).
   *
   *  `viewed` / `purchased` are booleans we derive from the underlying
   *  VT3 fields so the UI chip render stays simple. `purchaseType` is
   *  the raw VT3 string (e.g. 'FREE', 'PAID') for chip tooltips. */
  viewed?: boolean;
  firstViewedAt?: string;
  lastViewedAt?: string;
  purchased?: boolean;
  purchaseType?: string;
  unlockedAt?: string;
  /** Block state — mirrored from `lib/video-block.ts` onto the match
   *  record so the admin list can render a chip without a second
   *  Redis round-trip. Block "source of truth" stays on the block
   *  keys (video/person/session); this is a cached copy that the
   *  cron refreshes each tick. */
  blocked?: boolean;
  blockLevel?: "video" | "person" | "session";
  blockReason?: string;
  blockedAt?: string;
  /** Email-to-customer-profile push to VT3 (POST /videos/{code}/customer).
   *  Tracked so the cron doesn't keep re-linking the same email on
   *  every overlay pass. Reset to undefined if we ever change the
   *  associated email (e.g., admin re-sends with override). */
  vt3CustomerLinked?: boolean;
  vt3CustomerLinkedEmail?: string;
  vt3CustomerLinkedAt?: string;
}

function matchKey(sessionId: string | number, personId: string | number): string {
  return `video-match:${sessionId}:${personId}`;
}

function seenVideoKey(videoCode: string): string {
  return `video-match:by-code:${videoCode}`;
}

/** Time-ordered log so the admin UI can pull "today's matches" in O(log n). */
const MATCH_LOG_KEY = "video-match:log";

const LAST_SEEN_KEY = "vt3:last-seen-id";

/**
 * Persist a match. Writes both the primary record and a by-code
 * sentinel so the cron skips this video on subsequent runs.
 *
 * `setIfAbsent` protects against the pathological case where two
 * concurrent cron runs try to match the same video — only the first
 * succeeds.
 */
export async function saveVideoMatch(m: VideoMatch): Promise<boolean> {
  const sentinel = seenVideoKey(m.videoCode);
  const ok = await redis.set(sentinel, JSON.stringify({ sessionId: m.sessionId, personId: m.personId, matchedAt: m.matchedAt }), "EX", TTL_SECONDS, "NX");
  if (!ok) return false; // someone else matched this video first
  await redis.set(matchKey(m.sessionId, m.personId), JSON.stringify(m), "EX", TTL_SECONDS);
  // Index into the time-ordered match log for the admin UI.
  // Score = matchedAt epoch ms; member = `${sessionId}:${personId}` (the
  // primary key of the match record). Trim aggressively so the log
  // doesn't grow unbounded — keep the newest 10k entries which covers
  // well over a year at current volume.
  const score = new Date(m.matchedAt).getTime();
  if (Number.isFinite(score)) {
    await redis.zadd(MATCH_LOG_KEY, score, `${m.sessionId}:${m.personId}`);
    await redis.zremrangebyrank(MATCH_LOG_KEY, 0, -10001);
  }
  return true;
}

/**
 * Update an already-persisted match record (no sentinel re-check).
 * Use after `saveVideoMatch` returned true, to patch in notify
 * outcomes (notifySmsOk / notifyEmailOk) without tripping the NX guard.
 */
export async function updateVideoMatch(m: VideoMatch): Promise<void> {
  await redis.set(matchKey(m.sessionId, m.personId), JSON.stringify(m), "EX", TTL_SECONDS);
}

export async function hasVideoBeenMatched(videoCode: string): Promise<boolean> {
  return !!(await redis.get(seenVideoKey(videoCode)));
}

export async function getVideoForRacer(
  sessionId: string | number,
  personId: string | number,
): Promise<VideoMatch | null> {
  const raw = await redis.get(matchKey(sessionId, personId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Last-seen-id lets the cron skip videos it's already processed.
 * Returns 0 if nothing has ever been seen.
 */
export async function getLastSeenVideoId(): Promise<number> {
  const raw = await redis.get(LAST_SEEN_KEY);
  const n = parseInt(raw || "0", 10);
  return Number.isFinite(n) ? n : 0;
}

export async function setLastSeenVideoId(id: number): Promise<void> {
  await redis.set(LAST_SEEN_KEY, String(id));
}

/**
 * List matches for a date range, newest first. Used by the admin UI.
 *   startMs / endMs — epoch millisecond window (inclusive)
 *   limit          — max records, default 200
 */
export async function listMatchesInRange(opts: {
  startMs: number;
  endMs: number;
  limit?: number;
}): Promise<VideoMatch[]> {
  const { startMs, endMs, limit = 200 } = opts;
  const ids = await redis.zrevrangebyscore(
    MATCH_LOG_KEY,
    endMs,
    startMs,
    "LIMIT",
    0,
    Math.max(1, Math.min(1000, limit)),
  );
  if (!ids || ids.length === 0) return [];
  // ids are `${sessionId}:${personId}` — split and bulk-fetch.
  const keys = ids.map((id: string) => `video-match:${id}`);
  const raws = await redis.mget(...keys);
  const out: VideoMatch[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    try { out.push(JSON.parse(raw)); } catch { /* skip */ }
  }
  return out;
}

/** Update an in-place match (after resend, to patch notify status). */
export async function getMatch(
  sessionId: string | number,
  personId: string | number,
): Promise<VideoMatch | null> {
  const raw = await redis.get(matchKey(sessionId, personId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Lookup a match record by its video code. Two-hop via the
 * video-match:by-code sentinel → the full record. Used by the cron
 * to detect "already matched, may still need notify" rows on
 * subsequent ticks when a pending-notify video's VT3 status finally
 * transitions to preview-ready.
 */
export async function getMatchByVideoCode(videoCode: string): Promise<VideoMatch | null> {
  try {
    const sentinelRaw = await redis.get(seenVideoKey(videoCode));
    if (!sentinelRaw) return null;
    const sentinel = JSON.parse(sentinelRaw) as { sessionId?: string | number; personId?: string | number };
    if (!sentinel.sessionId || !sentinel.personId) return null;
    return await getMatch(sentinel.sessionId, sentinel.personId);
  } catch {
    return null;
  }
}
