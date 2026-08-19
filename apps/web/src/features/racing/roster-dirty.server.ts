import "server-only";

/**
 * THE WIRE'S SIDE OF THE ROSTER TRIGGER — write only, reads nothing back.
 *
 * The webhook marks the sessions the venue just mentioned; `pre-race-tickets`
 * reads those marks and only pays Pandora for the sessions that moved. See
 * roster-dirty.ts for what counts as a touch and why.
 *
 * ── WHY A COUNTER AND NOT A TIMESTAMP ───────────────────────────────────────
 *
 * The obvious design stores "last touched at". It is wrong here, because it
 * needs a MAX to be safe and Redis has no atomic numeric max: two invocations
 * writing 12:00:01 and 12:00:00 can land in either order, and an older stamp
 * overwriting a newer one is a change we then never read. The bridge POSTs
 * serially today, but nothing in Vercel guarantees our invocations process in
 * that order, and inheriting that assumption to save a keystroke is how a
 * once-a-week ghost gets written.
 *
 * `INCR` has no such ordering: it is atomic and commutative, so N touches in
 * any order leave the same value. The cron compares the counter it banked
 * against the counter now — different means something happened, and it does not
 * care what, when, or in what order.
 *
 * A key that EXPIRES restarts the counter at 0 while the cron still holds, say,
 * 7. That reads as "different", which triggers exactly one wasted Pandora read
 * and then re-syncs. Being wrong in the direction of one extra read is the
 * whole design.
 */
import redis from "@/lib/redis";
import { rosterTouchedSessionIds } from "./roster-dirty";

/** Long enough to outlive a race day, short enough that yesterday's heats do
 *  not accumulate. Refreshed on every touch. */
const DIRTY_TTL_SECONDS = 60 * 60 * 24;
/** The cron's bookmark. Same lifetime — the pair is only meaningful together. */
const READ_TTL_SECONDS = 60 * 60 * 24;

export const dirtyKey = (sessionId: string) => `venue:roster:dirty:${sessionId}`;
export const readKey = (sessionId: string) => `venue:roster:read:${sessionId}`;

/**
 * Mark every session this message mentions. NEVER THROWS — it runs inside the
 * webhook's `after()` alongside the race clock and the incident log, and a
 * Redis blip here must cost one tick of freshness, never a 500 back to the
 * bridge.
 */
export async function markRosterTouched(message: unknown): Promise<number> {
  let marked = 0;
  try {
    const ids = rosterTouchedSessionIds(message);
    if (ids.length === 0) return 0;
    const pipe = redis.pipeline();
    for (const id of ids) {
      pipe.incr(dirtyKey(id));
      pipe.expire(dirtyKey(id), DIRTY_TTL_SECONDS);
    }
    await pipe.exec();
    marked = ids.length;
  } catch (err) {
    console.warn("[roster-dirty] mark failed:", err);
  }
  return marked;
}

export interface RosterMarks {
  dirtyCounter: number | null;
  readCounter: number | null;
  lastReadMs: number | null;
}

/**
 * The dirty counter and our bookmark for many sessions, in ONE round trip.
 *
 * Batched on purpose: the all-day scope means ~60 sessions per tick, and 120
 * sequential Redis GETs would put more latency into this cron than the Pandora
 * reads it exists to remove.
 */
export async function readRosterMarks(sessionIds: string[]): Promise<Map<string, RosterMarks>> {
  const out = new Map<string, RosterMarks>();
  for (const id of sessionIds) {
    out.set(id, { dirtyCounter: null, readCounter: null, lastReadMs: null });
  }
  if (sessionIds.length === 0) return out;
  try {
    const keys = sessionIds.flatMap((id) => [dirtyKey(id), readKey(id)]);
    const values = await redis.mget(...keys);
    sessionIds.forEach((id, idx) => {
      const dirtyRaw = values[idx * 2];
      const readRaw = values[idx * 2 + 1];
      // The bookmark is "<counter>:<readAtMs>" — one key, so the pair can never
      // be half-written by a crash between two writes.
      let readCounter: number | null = null;
      let lastReadMs: number | null = null;
      if (readRaw) {
        const [c, at] = readRaw.split(":");
        const cn = Number(c);
        const an = Number(at);
        if (Number.isFinite(cn)) readCounter = cn;
        if (Number.isFinite(an)) lastReadMs = an;
      }
      const dn = dirtyRaw === null || dirtyRaw === undefined ? null : Number(dirtyRaw);
      out.set(id, {
        dirtyCounter: dn !== null && Number.isFinite(dn) ? dn : null,
        readCounter,
        lastReadMs,
      });
    });
  } catch (err) {
    console.warn("[roster-dirty] mark read failed:", err);
    // Every session stays null, so planRosterRead answers "never-read" and the
    // tick reads every roster it can see rather than skipping on missing marks.
    //
    // Worth being precise about the degraded case: a WHOLE Redis outage also
    // fails the heartbeat read in the caller, which lands on "bridge-stale" and
    // pulls the scope back to the e-ticket window — i.e. exactly the old
    // behaviour. Only the narrow case of an mget failing while the heartbeat
    // still reads costs one all-day sweep, which self-corrects on the next tick.
  }
  return out;
}

/**
 * Bank the counter we are reading PAST.
 *
 * `counterAtStart` must be the value observed BEFORE the Pandora read was
 * issued, never after: a racer added while the read was in flight bumps the
 * counter, and banking the later value would swallow that change until the net
 * fired. Banking the earlier one costs one extra read on the next tick, which
 * is the right way round.
 */
export async function bankRosterRead(
  sessionId: string,
  counterAtStart: number | null,
  atMs: number,
): Promise<void> {
  try {
    await redis.set(readKey(sessionId), `${counterAtStart ?? 0}:${atMs}`, "EX", READ_TTL_SECONDS);
  } catch (err) {
    console.warn("[roster-dirty] bank failed:", err);
  }
}
