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

// Both matched and unmatched video records share a 30-day TTL so the
// admin UI's "look back N days" workflow gives staff a full month of
// history to inspect, resend, or manually link captures regardless of
// match state. Was 90d for matched + 7d for unmatched; ops asked for
// the unified 30-day window.
const TTL_DAYS = 30;
const TTL_SECONDS = 60 * 60 * 24 * TTL_DAYS;

/**
 * Whether the racer-facing public viewer (vt3.io/?code=X) can play
 * something for this video.
 *
 * Single rule: `sampleUploadTime` is set on the VT3 record. That
 * field's signed R2 URL is exactly what `sys.vt3.io/videos/code/{code}/check`
 * returns as `sample.url`, which is what the public player consumes.
 * If the field is set, the racer's link works. If it's not, the page
 * shows "still processing".
 *
 * We deliberately ignore the `status` name. VT3 has 7+ status values
 * across the upload pipeline (TRANSFERRING / PENDING_UPLOAD /
 * TRANSFERRED / SAMPLING / PROCESSING / FOR_ENCODING / IS_ENCODING /
 * ENCODING / PENDING_ACTIVATION / UPLOADED / ACTIVE / READY), the set
 * isn't documented, and it changes without notice — earlier blocklist
 * AND allowlist approaches both leaked. sampleUploadTime is the actual
 * data signal the public viewer uses, so use that.
 */
export interface NotifyReadinessSignals {
  /** Optional status, kept for logs / admin UI labels — IGNORED by the
   *  gate. Don't add it back to the readiness check; see above. */
  status?: string | null;
  /** ISO timestamp from VT3's `sampleUploadTime`. Presence == ready. */
  sampleUploadTime?: string | null;
}

/** True when the public viewer can serve the sample preview. */
export function isVideoReadyForNotify(signals: NotifyReadinessSignals | undefined | null): boolean {
  if (!signals) return false;
  return !!signals.sampleUploadTime;
}

/**
 * Junk-clip quarantine (2026-08-02 hardening).
 *
 * Cameras bumped on the dock / powered on in someone's hand produce
 * 0–60s "videos" that VT3 uploads like any other. The 7/10–7/28 live
 * corpus had 152 of them MATCHED to racers (one 1-second clip was
 * SMS'd, carrier-delivered, and viewed — the Jessica May complaint),
 * and 39 provable cases where the junk consumed the racer's one slot
 * so their real video sat in the review bucket unsent.
 *
 * Threshold rationale: real races cluster ≥600s (96.8% of matched);
 * legitimately SHORT videos are crash-shortened heats, and the
 * shortest crash video in the corpus was 133s. <120s was 100% junk.
 * Tune via VIDEO_JUNK_MIN_S; kill via VIDEO_JUNK_QUARANTINE=false
 * (kill switch only — defaults ON per the house flag rule).
 */
export function junkMinDurationS(): number {
  const raw = parseInt(process.env.VIDEO_JUNK_MIN_S || "120", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 120;
}

export function junkQuarantineEnabled(): boolean {
  return process.env.VIDEO_JUNK_QUARANTINE !== "false";
}

/** True when a duration marks a video as junk-grade (quarantine on,
 *  duration known, and under the floor). Unknown durations are NOT
 *  junk — we can't judge them; the junk→real swap covers the case
 *  where one later matches and turns out tiny. */
export function isJunkDuration(duration?: number | null): boolean {
  if (!junkQuarantineEnabled()) return false;
  return (
    typeof duration === "number" && Number.isFinite(duration) && duration < junkMinDurationS()
  );
}

/** True when `incoming` (a real, known-length video) should displace
 *  `occupantDuration` (a junk-grade clip) from a racer's slot. Both
 *  sides must be KNOWN: we never displace for an unknown-length
 *  incoming video, and never displace a real occupant. */
export function shouldDisplaceJunk(
  occupantDuration: number | null | undefined,
  incomingDuration: number | null | undefined,
): boolean {
  if (!junkQuarantineEnabled()) return false;
  return (
    isJunkDuration(occupantDuration) &&
    typeof incomingDuration === "number" &&
    Number.isFinite(incomingDuration) &&
    incomingDuration >= junkMinDurationS()
  );
}

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
  customerUrl: string; // https://vt3.io/?code={code}
  shortUrl?: string; // our /s/{code} redirect so clicks track
  thumbnailUrl?: string;
  capturedAt: string; // video.created_at (ISO)
  duration?: number; // seconds
  matchedAt: string; // when the cron made the link (ISO)
  sessionName?: string;
  scheduledStart?: string;
  track?: string;
  raceType?: string;
  heatNumber?: number;
  /** Snapshot of contact info at match time — duplicated from the
   *  camera-history entry so the admin-resend endpoint doesn't need
   *  to walk back to the history set. */
  email?: string;
  phone?: string; // canonical or raw — use canonicalizePhone
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
  /** ISO timestamp from VT3's `sampleUploadTime` field — set as soon
   *  as the low-res preview clip lands in R2. Presence of this is the
   *  authoritative signal that vt3.io/?code=X can play SOMETHING for
   *  the racer (verified via the public /check endpoint's `sample.url`
   *  field). Drives the notify gate alongside videoStatus. */
  sampleUploadTime?: string;
  /** ISO timestamp from VT3's `uploadTime` — set when the full HD
   *  encode is also available. Distinguishes "sample preview only"
   *  from "full video ready". Currently informational; the notify
   *  gate fires on sampleUploadTime alone. */
  uploadTime?: string;
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
 * Unmatched-video registry. Populated by the webhook when a VT3 capture
 * event arrives for a kart with no active camera-assign — instead of
 * dropping the record, we persist it here so the admin UI can show
 * "every video for the day" without a 200-record VT3 polling cap.
 *
 * When a previously-unmatched video later gets matched (cron catch-up,
 * or staff manually sending), `saveVideoMatch` removes the record so
 * the admin's matched + unmatched view stays mutually exclusive.
 *
 * 30-day TTL — same as matched records (TTL_SECONDS) so the admin
 * UI's "look back N days" workflow gives staff a unified one-month
 * history regardless of match state.
 */
const UNMATCHED_TTL_SECONDS = TTL_SECONDS;
const UNMATCHED_LOG_KEY = "video-unmatched:log";
function unmatchedKey(videoCode: string): string {
  return `video-unmatched:${videoCode}`;
}

export interface UnmatchedVideo {
  videoId: number;
  videoCode: string;
  systemNumber: string;
  cameraNumber?: number;
  customerUrl: string;
  thumbnailUrl?: string;
  capturedAt: string;
  duration?: number;
  /** Mirrors capturedAt so the admin UI sort + display logic stays
   *  uniform across matched/unmatched rows. */
  matchedAt: string;
  videoStatus?: string;
  sampleUploadTime?: string | null;
  /** Latest update time — webhook events for the same code overwrite
   *  the record, so this lets the admin UI show "captured 4:12 PM,
   *  last update 4:18 PM (encoded)". */
  lastWebhookEventAt: string;
  /** Optional VT3 overlay — populated by the cron's overlay refresh
   *  pass. Lets the admin UI show 👁 viewed / 💰 purchased chips on
   *  unmatched rows the same way it does for matched rows. */
  viewed?: boolean;
  firstViewedAt?: string;
  lastViewedAt?: string;
  purchased?: boolean;
  purchaseType?: string;
  unlockedAt?: string;
  /** Why this video sits in the review bucket. Absent (legacy records
   *  included) = plain "no assignment at capture time".
   *  "duplicate-assignment" = every eligible assignment for this
   *  camera already holds a different video, so auto-sending would
   *  either text the wrong racer or overwrite a correct match — held
   *  for staff to send manually instead.
   *  "junk-short" = duration under the junk floor (dock-bump / test
   *  clip) — quarantined so it can't consume a racer's slot or fire
   *  an SMS; staff can still send manually if it's somehow real. */
  reason?: "duplicate-assignment" | "junk-short";
  /** The videoCode already saved on the slot this video would have
   *  taken. Gives staff the "which video got there first" context. */
  existingVideoCode?: string;
  /** Snapshot of the newest eligible assignment — who staff should
   *  probably contact. In the usual failure mode (next racer's heat
   *  never got scanned) this is the PREVIOUS racer, and the held
   *  video belongs to whoever raced after them. */
  suggested?: {
    sessionId: string | number;
    personId: string | number;
    firstName: string;
    lastName: string;
    heatNumber?: number;
    track?: string;
    sessionName?: string;
    phone?: string;
    email?: string;
  };
}

/**
 * Persist (or overwrite) an unmatched-video record. Called by the
 * webhook's `skip-no-assignment` branch. Multiple events for the
 * same code overwrite each other — we keep the latest snapshot.
 */
export async function recordUnmatchedVideo(rec: UnmatchedVideo): Promise<void> {
  await redis.set(unmatchedKey(rec.videoCode), JSON.stringify(rec), "EX", UNMATCHED_TTL_SECONDS);
  // Score by capturedAt so listUnmatchedInRange can do an O(log n)
  // range scan keyed on the kart-capture time, not the webhook receive
  // time. Trim to 20000 newest — covers ~30 days of busy traffic
  // (roughly 600/day capture peak × 30 days, with headroom).
  const score = new Date(rec.capturedAt || rec.matchedAt).getTime();
  if (Number.isFinite(score)) {
    await redis.zadd(UNMATCHED_LOG_KEY, score, rec.videoCode);
    await redis.zremrangebyrank(UNMATCHED_LOG_KEY, 0, -20001);
  }
}

/**
 * Remove an unmatched record. Called by `saveVideoMatch` when a
 * formerly-unmatched code gets linked to a racer, so the admin
 * UI doesn't show the same video as both matched and unmatched.
 */
export async function removeUnmatchedVideo(videoCode: string): Promise<void> {
  await redis.del(unmatchedKey(videoCode));
  await redis.zrem(UNMATCHED_LOG_KEY, videoCode);
}

/**
 * Range scan over the unmatched log. Mirrors listMatchesInRange's
 * shape so the admin route can call both with the same window.
 */
export async function listUnmatchedInRange(opts: {
  startMs: number;
  endMs: number;
  limit?: number;
}): Promise<UnmatchedVideo[]> {
  const { startMs, endMs, limit = 500 } = opts;
  const codes = await redis.zrevrangebyscore(
    UNMATCHED_LOG_KEY,
    endMs,
    startMs,
    "LIMIT",
    0,
    Math.max(1, Math.min(2000, limit)),
  );
  if (!codes || codes.length === 0) return [];
  const keys = codes.map((c: string) => unmatchedKey(c));
  const raws = await redis.mget(...keys);
  const out: UnmatchedVideo[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * One-shot patch helper for VT3 overlay updates (viewed/purchased).
 * Used by the overlay-refresh pass when the same code is still in the
 * unmatched bucket but VT3 reports new impression / unlock state.
 */
export async function patchUnmatchedOverlay(
  videoCode: string,
  patch: Partial<
    Pick<
      UnmatchedVideo,
      "viewed" | "firstViewedAt" | "lastViewedAt" | "purchased" | "purchaseType" | "unlockedAt"
    >
  >,
): Promise<void> {
  const raw = await redis.get(unmatchedKey(videoCode));
  if (!raw) return;
  let cur: UnmatchedVideo;
  try {
    cur = JSON.parse(raw) as UnmatchedVideo;
  } catch {
    return;
  }
  const next = { ...cur, ...patch };
  await redis.set(unmatchedKey(videoCode), JSON.stringify(next), "EX", UNMATCHED_TTL_SECONDS);
}

/**
 * Persist a match. Writes both the primary record and a by-code
 * sentinel so the cron skips this video on subsequent runs.
 *
 * Two NX guards, two distinct outcomes:
 *   "already-processed"    — the by-code sentinel exists: another
 *                            path (cron vs webhook) claimed this
 *                            VIDEO first. Caller exits cleanly.
 *   "duplicate-assignment" — the racer's (sessionId, personId) slot
 *                            already holds a DIFFERENT video. Before
 *                            this guard, the second video silently
 *                            overwrote the first (2026-07-12
 *                            incident: un-scanned next racer's video
 *                            replaced the previous racer's real one).
 *                            Caller advances to the next unfilled
 *                            assignment or holds for review.
 * A same-code re-save (sentinel TTL'd out while overlay updates kept
 * the record alive) keeps the old plain-overwrite behavior.
 */
export type SaveVideoMatchOutcome = "saved" | "already-processed" | "duplicate-assignment";

export async function saveVideoMatch(m: VideoMatch): Promise<SaveVideoMatchOutcome> {
  const sentinel = seenVideoKey(m.videoCode);
  const ok = await redis.set(
    sentinel,
    JSON.stringify({ sessionId: m.sessionId, personId: m.personId, matchedAt: m.matchedAt }),
    "EX",
    TTL_SECONDS,
    "NX",
  );
  if (!ok) return "already-processed"; // someone else matched this video first
  const slotOk = await redis.set(
    matchKey(m.sessionId, m.personId),
    JSON.stringify(m),
    "EX",
    TTL_SECONDS,
    "NX",
  );
  if (!slotOk) {
    let existingCode: string | undefined;
    try {
      const raw = await redis.get(matchKey(m.sessionId, m.personId));
      existingCode = raw ? (JSON.parse(raw) as VideoMatch).videoCode : undefined;
    } catch {
      /* unparseable — treat as same-code overwrite below */
    }
    if (existingCode && existingCode !== m.videoCode) {
      // Slot taken by a different video. Roll the sentinel back so a
      // later event for THIS code re-runs the walk (and so a manual
      // send from the admin can still create its record) — a sentinel
      // pointing at a slot we don't own would cross-contaminate
      // getMatchByVideoCode lookups.
      await redis.del(sentinel).catch(() => void 0);
      return "duplicate-assignment";
    }
    // Same code (or unreadable record) — status-quo overwrite.
    await redis.set(matchKey(m.sessionId, m.personId), JSON.stringify(m), "EX", TTL_SECONDS);
  }
  // Index into the time-ordered match log for the admin UI.
  // Score = matchedAt epoch ms; member = `${sessionId}:${personId}` (the
  // primary key of the match record). Trim aggressively so the log
  // doesn't grow unbounded — keep the newest 20k entries to match the
  // unmatched-bucket cap. With the 30-day TTL on records, this covers
  // ~30 days of peak traffic (~600 matches/day) with comfortable headroom.
  const score = new Date(m.matchedAt).getTime();
  if (Number.isFinite(score)) {
    await redis.zadd(MATCH_LOG_KEY, score, `${m.sessionId}:${m.personId}`);
    await redis.zremrangebyrank(MATCH_LOG_KEY, 0, -20001);
  }
  // Drop any unmatched-bucket record so the admin's matched + unmatched
  // views stay mutually exclusive (no double-listing of the same video).
  await removeUnmatchedVideo(m.videoCode).catch(() => void 0);
  return "saved";
}

/**
 * Update an already-persisted match record (no sentinel re-check).
 * Use after `saveVideoMatch` returned "saved", to patch in notify
 * outcomes (notifySmsOk / notifyEmailOk) without tripping the NX guard.
 */
export async function updateVideoMatch(m: VideoMatch): Promise<void> {
  await redis.set(matchKey(m.sessionId, m.personId), JSON.stringify(m), "EX", TTL_SECONDS);
}

/**
 * Swap a junk-grade occupant out of a racer's slot and install the
 * real video in its place (2026-08-02 hardening — see isJunkDuration).
 *
 * Caller contract: `occupant` is the record currently in the slot for
 * (replacement.sessionId, replacement.personId), verified junk-grade
 * via shouldDisplaceJunk, and `replacement.videoCode` has NO existing
 * match (the caller reached PATH 2). Deliberately NOT NX-guarded —
 * this is an intentional overwrite of a slot we just read.
 *
 * Writes, in order:
 *   1. the displaced junk into the review bucket (reason "junk-short",
 *      suggested = the slot's racer so staff keep the context)
 *   2. the replacement record onto the slot key
 *   3. a by-code sentinel for the replacement code
 *   4. deletes the junk code's sentinel (future events for it re-land
 *      in the review bucket via the quarantine gate)
 *   5. match-log index refresh + unmatched-bucket cleanup for the
 *      replacement code
 */
export async function displaceVideoMatch(
  occupant: VideoMatch,
  replacement: VideoMatch,
): Promise<void> {
  const displaced: UnmatchedVideo = {
    videoId: occupant.videoId,
    videoCode: occupant.videoCode,
    systemNumber: occupant.systemNumber,
    cameraNumber: occupant.cameraNumber,
    customerUrl: occupant.customerUrl,
    thumbnailUrl: occupant.thumbnailUrl,
    capturedAt: occupant.capturedAt,
    duration: occupant.duration,
    matchedAt: occupant.capturedAt,
    videoStatus: occupant.videoStatus,
    sampleUploadTime: occupant.sampleUploadTime ?? null,
    lastWebhookEventAt: new Date().toISOString(),
    viewed: occupant.viewed,
    firstViewedAt: occupant.firstViewedAt,
    lastViewedAt: occupant.lastViewedAt,
    purchased: occupant.purchased,
    purchaseType: occupant.purchaseType,
    unlockedAt: occupant.unlockedAt,
    reason: "junk-short",
    existingVideoCode: replacement.videoCode,
    suggested: {
      sessionId: replacement.sessionId,
      personId: replacement.personId,
      firstName: replacement.firstName,
      lastName: replacement.lastName,
      heatNumber: replacement.heatNumber,
      track: replacement.track,
      sessionName: replacement.sessionName,
      phone: replacement.phone || replacement.mobilePhone || replacement.homePhone,
      email: replacement.email,
    },
  };
  await recordUnmatchedVideo(displaced);

  await redis.set(
    matchKey(replacement.sessionId, replacement.personId),
    JSON.stringify(replacement),
    "EX",
    TTL_SECONDS,
  );
  await redis.set(
    seenVideoKey(replacement.videoCode),
    JSON.stringify({
      sessionId: replacement.sessionId,
      personId: replacement.personId,
      matchedAt: replacement.matchedAt,
    }),
    "EX",
    TTL_SECONDS,
  );
  await redis.del(seenVideoKey(occupant.videoCode)).catch(() => void 0);

  const score = new Date(replacement.matchedAt).getTime();
  if (Number.isFinite(score)) {
    await redis.zadd(MATCH_LOG_KEY, score, `${replacement.sessionId}:${replacement.personId}`);
    await redis.zremrangebyrank(MATCH_LOG_KEY, 0, -20001);
  }
  await removeUnmatchedVideo(replacement.videoCode).catch(() => void 0);
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
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
  // Ceiling raised 1000 -> 5000 to support the racing-survey week backfill
  // (a 7-day window can exceed 1000 matches on a busy stretch). Other
  // callers pass much smaller limits, so the higher ceiling is inert for them.
  const ids = await redis.zrevrangebyscore(
    MATCH_LOG_KEY,
    endMs,
    startMs,
    "LIMIT",
    0,
    Math.max(1, Math.min(5000, limit)),
  );
  if (!ids || ids.length === 0) return [];
  // ids are `${sessionId}:${personId}` — split and bulk-fetch.
  const keys = ids.map((id: string) => `video-match:${id}`);
  const raws = await redis.mget(...keys);
  const out: VideoMatch[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      /* skip */
    }
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
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
    const sentinel = JSON.parse(sentinelRaw) as {
      sessionId?: string | number;
      personId?: string | number;
    };
    if (!sentinel.sessionId || !sentinel.personId) return null;
    return await getMatch(sentinel.sessionId, sentinel.personId);
  } catch {
    return null;
  }
}
