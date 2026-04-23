import redis from "@/lib/redis";

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
  /** Kart / system ID — the 3-digit number (e.g. "913") that's on
   *  the kart body and comes through as video.system.name on vt3.io.
   *  This is what the NFC scan picks up in the camera-assign tool. */
  cameraNumber: string;
  /** Hardware camera ID — vt3's internal camera serial (e.g. 20),
   *  different from the kart number. Populated from video.camera. */
  cameraId?: number;
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
  /** Notification status set by the cron after SMS/email attempts. */
  notifySmsOk?: boolean;
  notifySmsError?: string;
  notifySmsSentTo?: string;
  notifySmsSentAt?: string;
  notifyEmailOk?: boolean;
  notifyEmailError?: string;
  notifyEmailSentTo?: string;
  notifyEmailSentAt?: string;
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
