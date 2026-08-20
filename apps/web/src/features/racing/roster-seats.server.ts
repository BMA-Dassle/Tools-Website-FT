import "server-only";

/**
 * The webhook's side of the sold-seat departure witness. See roster-seats.ts
 * for what counts as a departure and why only Product-bearing seats do.
 *
 * Two keys per session:
 *   venue:roster:seats:{sid}     "<recordVersion>|<driverId,driverId,...>"
 *   venue:roster:departed:{sid}  a counter, INCR'd ONCE PER FRAME in which any
 *                                sold seat vanished — EVENTS, NOT PEOPLE. Three
 *                                racers leaving in one frame bumps it by one
 *                                (observed live 2026-08-19: session 59039437
 *                                read `departed=1` against two Pandora
 *                                scratches). Nothing should read it as a head
 *                                count; it answers "did a sold seat leave", and
 *                                Pandora answers who.
 *
 * THE SEAT SET IS A READ-MODIFY-WRITE, which everything else in this feature
 * deliberately avoids. It is safe here only because it is VERSION GUARDED: a
 * frame whose `RecordVersion` is not newer than the stored one is ignored, so
 * two invocations racing cannot let an older roster overwrite a newer one. That
 * matters because the older roster is usually the SHORTER one, and writing it
 * back would invent a departure on the next frame.
 *
 * The counter it feeds is an INCR for the same reason as the roster-dirty mark:
 * atomic, commutative, and the reader only ever asks "is it different from what
 * I banked".
 */
import redis from "@/lib/redis";
import { departedSeats, isNewerFrame, seatSnapshots } from "./roster-seats";

/** Outlives a race day; refreshed on every frame for a live session. */
const SEATS_TTL_SECONDS = 60 * 60 * 6;
const DEPARTED_TTL_SECONDS = 60 * 60 * 24;

export const seatsKey = (sessionId: string) => `venue:roster:seats:${sessionId}`;
export const departedKey = (sessionId: string) => `venue:roster:departed:${sessionId}`;

function encode(recordVersion: string | null, seatIds: string[]): string {
  return `${recordVersion ?? ""}|${seatIds.join(",")}`;
}

function decode(raw: string | null): { version: string | null; seatIds: string[] } {
  if (!raw) return { version: null, seatIds: [] };
  const idx = raw.indexOf("|");
  if (idx < 0) return { version: null, seatIds: [] };
  const version = raw.slice(0, idx) || null;
  const rest = raw.slice(idx + 1);
  return { version, seatIds: rest ? rest.split(",") : [] };
}

/**
 * Fold this message's rosters into the stored seat sets and count any sold seat
 * that left. NEVER THROWS — it runs in the webhook's `after()`, and a Redis
 * blip must cost one corroboration, never a 500 back to the bridge.
 *
 * Returns how many sessions recorded a departure, for the log line.
 */
export async function markSeatDepartures(message: unknown): Promise<number> {
  let departures = 0;
  try {
    const snapshots = seatSnapshots(message);
    if (snapshots.length === 0) return 0;
    for (const snap of snapshots) {
      const stored = decode(await redis.get(seatsKey(snap.sessionId)));
      if (!isNewerFrame(stored.version, snap.recordVersion)) continue;

      const gone = departedSeats(stored.seatIds, snap.seatIds);
      // Write the new set first: if the INCR below fails we would rather have
      // an accurate set and a missed corroboration (costing a grace period)
      // than a stale set that invents the same departure on every later frame.
      await redis.set(
        seatsKey(snap.sessionId),
        encode(snap.recordVersion, snap.seatIds),
        "EX",
        SEATS_TTL_SECONDS,
      );
      if (gone.length === 0) continue;
      const key = departedKey(snap.sessionId);
      await redis.incr(key);
      await redis.expire(key, DEPARTED_TTL_SECONDS);
      departures++;
    }
  } catch (err) {
    console.warn("[roster-seats] departure mark failed:", err);
  }
  return departures;
}

/**
 * The departure counters for a set of sessions, in one round trip.
 *
 * Null for a session with no counter — which is the common case and means "the
 * wire has not seen a sold seat leave this heat", NOT "nothing happened". The
 * caller must treat it as absence of corroboration, never as evidence.
 */
export async function readDepartureCounts(
  sessionIds: string[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  for (const id of sessionIds) out.set(id, null);
  if (sessionIds.length === 0) return out;
  try {
    const values = await redis.mget(...sessionIds.map(departedKey));
    sessionIds.forEach((id, i) => {
      const n = values[i] === null || values[i] === undefined ? null : Number(values[i]);
      out.set(id, n !== null && Number.isFinite(n) ? n : null);
    });
  } catch (err) {
    console.warn("[roster-seats] departure read failed:", err);
    // Everything stays null → no corroboration → the full grace applies, which
    // is exactly the behaviour before this existed.
  }
  return out;
}
