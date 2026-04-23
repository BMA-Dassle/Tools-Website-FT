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

  const payload = JSON.stringify(a);
  const watchPayload = JSON.stringify({
    sessionId: a.sessionId,
    personId: a.personId,
    firstName: a.firstName,
    lastName: a.lastName,
    cameraNumber: a.cameraNumber,
    sessionName: a.sessionName,
    scheduledStart: a.scheduledStart,
    track: a.track,
    heatNumber: a.heatNumber,
    assignedAt: a.assignedAt,
  });

  const pipeline = redis.pipeline();
  pipeline.set(primary, payload, "EX", TTL_SECONDS);
  pipeline.set(watch, watchPayload, "EX", TTL_SECONDS);
  pipeline.sadd(idx, String(a.personId));
  pipeline.expire(idx, TTL_SECONDS);
  await pipeline.exec();
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
