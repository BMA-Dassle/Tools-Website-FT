import "server-only";

/**
 * THE DAY'S HEATS, ACROSS EVERY TRACK — one place, because more than one thing
 * on the pit surface needs to ask "which heat comes after which", and the answer
 * is never the heat number.
 *
 * `tasks/lessons.md` (2026-07-11): Pandora's `heatNumber` is CREATION order, not
 * schedule order. A single staff-inserted session takes the day-max number, so
 * "later heat = bigger number" is false exactly on the nights it matters. Every
 * ordering question here is answered from `scheduledStart`.
 *
 * `fetchTrackSessions` hits Pandora directly (no request origin needed, so this
 * works from a cron or a feed build) and shares one 15-second cache
 * building-wide, which is what makes it safe to ask from the 2-second pulse: the
 * pulse gets a memo hit, and the upstream cost stays at three reads a minute.
 */
import { calendarYmdET } from "@/lib/race-business-day";
import { fetchTrackSessions } from "~/features/reservations-admin/race-live-state.server";
import type { TrackKey } from "../track";
import type { B2BSession } from "./back-to-back";

const TRACKS: TrackKey[] = ["blue", "red", "mega"];

/** Every track's schedule for today, flattened and tagged with its track. */
export async function daySessions(): Promise<B2BSession[]> {
  const ymd = calendarYmdET();
  const lists = await Promise.all(
    TRACKS.map(async (track) => {
      const rows = await fetchTrackSessions(track, ymd).catch(() => null);
      return (rows ?? []).map(
        (r): B2BSession => ({
          sessionId: String(r.sessionId),
          track,
          heatNumber: Number.isFinite(r.heatNumber) ? r.heatNumber : null,
          scheduledStart: r.scheduledStart,
          actualStart: r.actualStart ?? null,
          actualEnd: r.actualEnd ?? null,
        }),
      );
    }),
  );
  /**
   * A Mega day lists the same physical heat on more than one resource, so the
   * flattened day can carry duplicate sessionIds. Deduped here rather than in
   * the pure part: it is an artefact of how the schedule is READ, not a rule
   * about racers.
   */
  const seen = new Set<string>();
  const out: B2BSession[] = [];
  for (const row of lists.flat()) {
    if (!row.sessionId || seen.has(row.sessionId)) continue;
    seen.add(row.sessionId);
    out.push(row);
  }
  return out;
}

/** A session's own `scheduledStart`. Null when the schedule cannot be read —
 *  callers must treat that as "unknown", never as "earlier". */
export async function scheduledStartOf(sessionId: string): Promise<string | null> {
  try {
    const sessions = await daySessions();
    return sessions.find((s) => s.sessionId === sessionId)?.scheduledStart ?? null;
  } catch {
    return null;
  }
}

/**
 * Is the heat the timing socket has loaded scheduled strictly LATER than one of
 * ours? The "a later heat is up, so whatever happened to this one it is over"
 * recovery path — the only place the pit lane compares two different heats.
 *
 * FAILS CLOSED. An unreadable schedule, an unknown heat number, or a tie all
 * return false: the cost of a false "no" is a lane that waits for its real
 * finish marker, while the cost of a false "yes" is a group swept out of the
 * seats mid-race. The only heat number used here is as a KEY to look a session
 * up; the comparison itself is on the clock.
 *
 * `track` scopes the lookup because heat numbers repeat across tracks — Red 33
 * and Blue 33 are different races, and the socket only ever speaks for one track.
 */
export async function liveHeatIsLaterThan(
  track: TrackKey,
  liveHeatNumber: number | null,
  ourHeatNumber: number | null,
): Promise<boolean> {
  if (liveHeatNumber == null || ourHeatNumber == null) return false;
  if (liveHeatNumber === ourHeatNumber) return false;
  try {
    const sessions = await daySessions();
    const onTrack = sessions.filter((s) => s.track === track);
    const live = onTrack.find((s) => s.heatNumber === liveHeatNumber);
    const ours = onTrack.find((s) => s.heatNumber === ourHeatNumber);
    if (!live || !ours) return false;
    const a = Date.parse(live.scheduledStart);
    const b = Date.parse(ours.scheduledStart);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return a > b;
  } catch {
    return false;
  }
}
