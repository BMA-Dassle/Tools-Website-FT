import redis from "@/lib/redis";

/**
 * Camera → racer assignments for a given race session.
 *
 * Front-desk flow:
 *   1. /admin/{token}/camera-assign loads the next upcoming session's
 *      participants.
 *   2. Staff scans each kart's NFC tag (a USB reader that types the camera
 *      number + Enter). The page assigns that camera to the currently
 *      highlighted racer and advances to the next.
 *   3. Each scan writes TWO Redis keys:
 *        - assignKey   — full record keyed by (sessionId, personId) for
 *                         the admin UI to list/edit
 *        - watchKey    — reverse lookup keyed by cameraNumber so a
 *                         downstream process (watching vt3.io / Viewpoint
 *                         for new video uploads) can resolve a camera
 *                         number back to the racer and attach the video
 *                         to their e-ticket.
 *
 * TTL: 24 hours. Covers the whole race day + some slack for video uploads
 * that arrive post-race.
 */

const TTL_SECONDS = 60 * 60 * 24; // 24h

export interface CameraAssignment {
  sessionId: string | number;
  personId: string | number;
  firstName: string;
  lastName: string;
  /** Session info captured at assign-time so the watcher doesn't need a Pandora refetch */
  sessionName?: string;
  scheduledStart?: string;
  track?: string;
  raceType?: string;
  heatNumber?: number;
  /** The number that came off the NFC tag (kart/camera ID) */
  cameraNumber: string;
  /** ISO timestamp of the scan */
  assignedAt: string;
  /** Email of the staff member who scanned (optional, for audit) */
  assignedBy?: string;
  /** Contact info for the "your video is ready" notification that
   *  fires when the camera returns + uploads to vt3.io. Captured at
   *  scan-in so the video-match cron doesn't need a second Pandora
   *  round-trip per match. */
  email?: string;
  mobilePhone?: string;
  homePhone?: string;
  phone?: string;
  acceptSmsCommercial?: boolean;
  acceptSmsScores?: boolean;
}

function assignKey(sessionId: string | number, personId: string | number): string {
  return `camera-assign:${sessionId}:${personId}`;
}

function watchKey(cameraNumber: string): string {
  return `camera-watch:${cameraNumber}`;
}

function sessionIndexKey(sessionId: string | number): string {
  return `camera-assign:session:${sessionId}`;
}

/**
 * Time-indexed history of assignments for a given camera. Sorted set,
 * score = assignedAt epoch ms, value = JSON of the assignment.
 * Used by the video-match cron: when a video uploads from camera C
 * at time T, we find the most recent history entry with score <= T
 * — that's the racer who had camera C at that moment. Critical for
 * days when the same kart/camera runs multiple heats with different
 * racers.
 */
function historyKey(cameraNumber: string): string {
  return `camera-history:${cameraNumber}`;
}

/**
 * Persist an assignment. Writes three entries atomically via a pipeline:
 *   1. The primary record keyed by (sessionId, personId)
 *   2. A camera-watch reverse lookup keyed by cameraNumber
 *   3. A set of personIds on this session (for fast "list all assignments
 *      for this session" without scanning all admin keys)
 *
 * If the camera was already assigned to a DIFFERENT racer in the same
 * session window, that prior watch entry is overwritten — last scan wins.
 * If the same racer already had a camera, it gets replaced.
 */
export async function upsertCameraAssignment(a: CameraAssignment): Promise<void> {
  const primary = assignKey(a.sessionId, a.personId);
  const watch = watchKey(a.cameraNumber);
  const idx = sessionIndexKey(a.sessionId);
  const hist = historyKey(a.cameraNumber);

  const payload = JSON.stringify(a);
  // Watch + history payloads include contact fields so the video-match
  // cron can deliver the "video ready" notification without re-fetching
  // from Pandora.
  const watchPayload = JSON.stringify({
    sessionId: a.sessionId,
    personId: a.personId,
    firstName: a.firstName,
    lastName: a.lastName,
    cameraNumber: a.cameraNumber,
    sessionName: a.sessionName,
    scheduledStart: a.scheduledStart,
    track: a.track,
    raceType: a.raceType,
    heatNumber: a.heatNumber,
    assignedAt: a.assignedAt,
    email: a.email,
    mobilePhone: a.mobilePhone,
    homePhone: a.homePhone,
    phone: a.phone,
    acceptSmsCommercial: a.acceptSmsCommercial,
    acceptSmsScores: a.acceptSmsScores,
  });
  const historyScore = new Date(a.assignedAt).getTime();

  const pipeline = redis.pipeline();
  pipeline.set(primary, payload, "EX", TTL_SECONDS);
  pipeline.set(watch, watchPayload, "EX", TTL_SECONDS);
  pipeline.sadd(idx, String(a.personId));
  pipeline.expire(idx, TTL_SECONDS);
  // Time-indexed history — same camera may have multiple assignments
  // across the day as karts rotate between heats. The video-match
  // cron reads this set and picks the entry with the largest score
  // that is still <= video.created_at.
  pipeline.zadd(hist, historyScore, watchPayload);
  pipeline.expire(hist, TTL_SECONDS);
  await pipeline.exec();
}

/**
 * Find who had a given camera at a specific moment. Used by the
 * video-match cron: takes the video's `created_at` (ISO string) and
 * the kart/camera number (`system.name` on VT3 records), returns the
 * most recent camera-assign whose assignedAt is earlier than the
 * video's capture time. Returns null if the camera was never
 * assigned (or the assignment TTL'd out before the video uploaded).
 */
export interface CameraHistoryEntry {
  sessionId: string | number;
  personId: string | number;
  firstName: string;
  lastName: string;
  cameraNumber: string;
  sessionName?: string;
  scheduledStart?: string;
  track?: string;
  raceType?: string;
  heatNumber?: number;
  assignedAt: string;
  email?: string;
  mobilePhone?: string;
  homePhone?: string;
  phone?: string;
  acceptSmsCommercial?: boolean;
  acceptSmsScores?: boolean;
}

export async function getAssignmentAtTime(
  cameraNumber: string,
  atIso: string,
): Promise<CameraHistoryEntry | null> {
  try {
    const atMs = new Date(atIso).getTime();
    if (!Number.isFinite(atMs)) return null;
    // ZREVRANGEBYSCORE → all entries ≤ atMs, highest first. LIMIT 0 1
    // gives us just the one we want.
    const result = await redis.zrevrangebyscore(
      historyKey(cameraNumber),
      atMs,
      "-inf",
      "LIMIT",
      0,
      1,
    );
    if (!result || result.length === 0) return null;
    return JSON.parse(result[0]);
  } catch {
    return null;
  }
}

/**
 * Load all camera assignments for one session.
 */
export async function listAssignmentsForSession(
  sessionId: string | number,
): Promise<CameraAssignment[]> {
  const idx = sessionIndexKey(sessionId);
  const personIds = await redis.smembers(idx);
  if (personIds.length === 0) return [];

  const keys = personIds.map((pid) => assignKey(sessionId, pid));
  const raws = await redis.mget(...keys);
  const out: CameraAssignment[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * Remove one assignment (both the primary record and the camera-watch
 * reverse lookup). Used when staff mis-scans and needs to redo.
 */
export async function deleteCameraAssignment(
  sessionId: string | number,
  personId: string | number,
): Promise<void> {
  const primary = assignKey(sessionId, personId);
  const raw = await redis.get(primary);
  if (raw) {
    try {
      const a = JSON.parse(raw) as CameraAssignment;
      if (a.cameraNumber) {
        // Only clear the watch if it STILL points at this assignment —
        // another racer may have since scanned the same camera.
        const watchRaw = await redis.get(watchKey(a.cameraNumber));
        if (watchRaw) {
          try {
            const w = JSON.parse(watchRaw);
            if (String(w.personId) === String(personId)) {
              await redis.del(watchKey(a.cameraNumber));
            }
          } catch { /* leave watch alone */ }
        }
      }
    } catch { /* best effort */ }
  }
  await redis.del(primary);
  await redis.srem(sessionIndexKey(sessionId), String(personId));
}

/**
 * Reverse lookup: given a camera number, which racer is expected to be
 * using it (if any)? Downstream Viewpoint watcher uses this to route a
 * freshly-uploaded video to the right racer's e-ticket.
 */
export async function getRacerByCamera(cameraNumber: string): Promise<{
  sessionId: string | number;
  personId: string | number;
  firstName: string;
  lastName: string;
  cameraNumber: string;
  sessionName?: string;
  scheduledStart?: string;
  track?: string;
  heatNumber?: number;
  assignedAt: string;
} | null> {
  try {
    const raw = await redis.get(watchKey(cameraNumber));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
