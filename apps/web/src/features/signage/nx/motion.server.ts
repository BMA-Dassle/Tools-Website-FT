import "server-only";

/**
 * "Has anything moved in this room lately?" — answered by the NVR, not by us.
 *
 * WHY THE NVR AND NOT PIXELS. Nx computes motion continuously for every camera
 * and stores it as searchable periods; asking for them is one authenticated GET
 * that returns a few hundred bytes. The alternative — pulling two JPEGs and
 * diffing them ourselves — needs an image decode on a serverless function, a
 * per-room reference frame that goes stale every time somebody moves a helmet
 * rack, and it would ship photographs of guests to a place they do not need to
 * go. The NVR already did this work. See [[reference-nx-witness-api]].
 *
 * MEASURED ON THE REAL ROOMS (2026-08-13 archive, both briefing cameras): motion
 * is recorded at 3-80s granularity, 373 periods on blue and 252 on red across one
 * evening. Replayed over that night's 75 briefings, "no motion for 30s" identified
 * the room emptying on 62 of them, a median 1:29 after the film's end, and every
 * firing checked against the archive still showed an empty room.
 *
 * ─── THE FAILURE DIRECTION IS THE WHOLE DESIGN ───────────────────────────
 *
 * An unreadable answer is `unknown`, and every caller must treat `unknown` as
 * "somebody is in there". This is not defensive habit, it is the specific bug
 * this module would otherwise cause: the relay intermittently answers 200 with an
 * EMPTY BODY (hit twice while probing). Parsed leniently, an empty body is an
 * empty period list, which reads as "no motion anywhere" — and the caller would
 * then declare EVERY briefing room empty at once, on the same tick. So a body we
 * cannot read is retried, and if it still cannot be read the answer is `unknown`
 * and nothing happens.
 */
import { nxConfigured, nxRelayGet } from "./camera.server";

/** What the NVR could tell us about a window of time in one room. */
export type MotionAnswer =
  /** The NVR recorded no motion at all across the window. */
  | "quiet"
  /** The NVR recorded motion overlapping the window. */
  | "motion"
  /** Not configured, unreachable, or an answer we could not read. Never "quiet". */
  | "unknown";

/**
 * How far BEFORE the window to start the query.
 *
 * A single motion period can begin well before the window and run into it — a
 * group milling about for two minutes is one period, not twelve. Querying only
 * the window itself risks the server returning nothing for a period that merely
 * started earlier, which would read as quiet in the middle of a busy room. So we
 * ask wide and decide the overlap ourselves.
 */
const LOOKBEHIND_MS = 10 * 60_000;

/** The empty-body retry described in the header. Two attempts, then `unknown`. */
const READ_ATTEMPTS = 2;

interface FootagePeriod {
  startTimeMs?: number | string;
  startTime?: number | string;
  durationMs?: number | string;
  duration?: number | string;
}

function toMs(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Was there recorded motion on this camera between `fromMs` and `nowMs`?
 *
 * `deviceId` comes from BRIEFING_ROOM_CAMERAS server-side — never from a client
 * — for the same reason the frame proxy resolves its own device: this must not
 * become a way to ask the NVR about an arbitrary camera.
 */
export async function motionBetween(
  deviceId: string,
  fromMs: number,
  nowMs: number,
): Promise<MotionAnswer> {
  if (!nxConfigured() || !deviceId) return "unknown";
  if (!Number.isFinite(fromMs) || !Number.isFinite(nowMs) || nowMs <= fromMs) return "unknown";

  const startTimeMs = Math.floor(fromMs - LOOKBEHIND_MS);
  const endTimeMs = Math.ceil(nowMs);
  const path =
    `/rest/v4/devices/${encodeURIComponent(deviceId)}/footage` +
    `?startTimeMs=${startTimeMs}&endTimeMs=${endTimeMs}&periodType=motion`;

  let body = "";
  for (let attempt = 0; attempt < READ_ATTEMPTS && !body; attempt++) {
    try {
      const res = await nxRelayGet(path);
      // A non-2xx is unknown, not quiet — see the header.
      if (!res.ok) return "unknown";
      body = await res.text();
    } catch {
      return "unknown";
    }
  }
  if (!body) return "unknown";

  let periods: FootagePeriod[];
  try {
    const parsed: unknown = JSON.parse(body);
    periods = Array.isArray(parsed)
      ? (parsed as FootagePeriod[])
      : ((parsed as { periods?: FootagePeriod[] })?.periods ?? []);
  } catch {
    return "unknown";
  }
  if (!Array.isArray(periods)) return "unknown";

  for (const p of periods) {
    const start = toMs(p.startTimeMs ?? p.startTime);
    if (!Number.isFinite(start)) continue;
    const dur = toMs(p.durationMs ?? p.duration);
    // A period with no readable duration is treated as an instant rather than
    // discarded: it is still evidence that something moved.
    const end = start + (Number.isFinite(dur) && dur > 0 ? dur : 1);
    if (start < nowMs && end > fromMs) return "motion";
  }
  return "quiet";
}

/** Convenience: has this camera been still for the last `windowMs`? */
export async function motionInLast(
  deviceId: string,
  windowMs: number,
  nowMs: number,
): Promise<MotionAnswer> {
  return motionBetween(deviceId, nowMs - windowMs, nowMs);
}
