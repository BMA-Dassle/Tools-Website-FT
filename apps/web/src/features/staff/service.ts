import "server-only";

/**
 * Resolve a typed punch ID to the person who holds it — fast enough for a
 * keypad on a wall tablet with a group waiting in the room.
 *
 * THE SHAPE OF THE PROBLEM. 7shifts cannot look up a user by punch ID (see
 * `~/lib/api/sevenshifts`), so resolving one means holding every user. Doing
 * that per keypress would be several seconds and a Cloudflare challenge inside
 * a busy hour. So the roster is paged ONCE per refresh window into a Redis
 * hash, and a press is a single HGET.
 *
 * ── THE THREE RULES THIS FILE EXISTS TO ENFORCE ─────────────────────────────
 *
 * 1. A HIT COSTS TWO SMALL REDIS READS — the hash field, and the freshness
 *    probe behind the `stale` flag. No API call, no JSON of 300 users crossing
 *    the wire, no dependency on 7shifts being up. This is the path taken ~100%
 *    of the time and it must stay boring.
 *
 * 2. A MISS ON A STALE INDEX REBUILDS ONCE, THEN RE-CHECKS. Otherwise a staff
 *    member hired this afternoon types a correct ID and is told it is wrong
 *    until the cache happens to expire. The rebuild is behind a lock, so a
 *    person mistyping four times in a row still triggers at most one page of
 *    7shifts per REBUILD_LOCK_SECONDS.
 *
 * 3. A STALE INDEX IS STILL SERVED. The hash outlives its freshness marker by a
 *    long way (INDEX_TTL vs REFRESH_SECONDS) precisely so that 7shifts being
 *    down, rate-limited or challenged does not brick the briefing rooms. An
 *    index built six hours ago still names everybody who was employed six hours
 *    ago, which is everybody. Fail open, loudly.
 */

import redis from "@/lib/redis";
import { listSevenShiftsUsers, isSevenShiftsConfigured } from "~/lib/api/sevenshifts";
import { buildPunchIndex, normalizePunchId, type StaffIdentity } from "./punch-index";

/** The hash: punchId → JSON(StaffIdentity). */
const INDEX_KEY = "staff:punch-index";
/** Punch IDs held by two active people. Excluded from the hash; see punch-index. */
const COLLISION_KEY = "staff:punch-index:collisions";
/** Present ⇒ the index was built recently. Its TTL is the refresh window. */
const FRESH_KEY = "staff:punch-index:fresh";
/** Held during a rebuild so concurrent misses cannot stampede 7shifts. */
const LOCK_KEY = "staff:punch-index:lock";

/** How long the index is considered current. A new hire is typeable within this. */
const REFRESH_SECONDS = 10 * 60;

/**
 * How long the index survives WITHOUT a successful rebuild. Deliberately far
 * longer than REFRESH_SECONDS — this is the fail-open window during a 7shifts
 * outage, not a correctness bound.
 */
const INDEX_TTL_SECONDS = 24 * 60 * 60;

/** At most one rebuild per this window, however many people are mistyping. */
const REBUILD_LOCK_SECONDS = 60;

export type PunchVerifyResult =
  | { ok: true; staff: StaffIdentity; stale: boolean }
  /** No active employee holds this punch ID. The honest "wrong code". */
  | { ok: false; reason: "unknown" }
  /** Two active employees hold it. Refuse rather than attribute to the wrong one. */
  | { ok: false; reason: "ambiguous" }
  /** No index and we could not build one — 7shifts unreachable on a cold cache. */
  | { ok: false; reason: "unavailable" };

/**
 * Page the whole roster and publish it as the index.
 *
 * A TRUNCATED PAGE RUN IS NOT PUBLISHED. `sevenShiftsGetAll` reports when it
 * hit its page ceiling; publishing that would delete real people from the index
 * and read to them as "your ID is wrong". Better to keep yesterday's complete
 * index and log loudly.
 *
 * The write is a replace, not a merge (DEL then HSET), so a departed employee
 * actually leaves. That is the one thing a merge would get wrong, and it is the
 * case that matters: an ex-employee must stop being able to sign for a group.
 */
export async function rebuildPunchIndex(): Promise<{ size: number; collisions: string[] } | null> {
  if (!isSevenShiftsConfigured()) {
    console.error("[staff] SEVEN_SHIFTS_API_TOKEN not set — punch index cannot be built");
    return null;
  }

  let users;
  try {
    const res = await listSevenShiftsUsers();
    if (res.truncated) {
      console.error(
        "[staff] 7shifts user listing was truncated — keeping the previous punch index",
      );
      return null;
    }
    users = res.items;
  } catch (e) {
    console.error("[staff] 7shifts user listing failed:", e instanceof Error ? e.message : e);
    return null;
  }

  // AN EMPTY ANSWER IS AN OUTAGE, NOT A COMPANY WITH NO STAFF. Never let one
  // overwrite a working index — that would read to every employee as "your ID
  // is wrong" at once.
  if (users.length === 0) {
    console.error("[staff] 7shifts returned no users — keeping the previous punch index");
    return null;
  }

  const { index, collisions, size } = buildPunchIndex(users);

  // Users came back but NOTHING was usable and nothing collided ⇒ the payload
  // shape moved under us (a renamed field), not a roster we should publish.
  // Collisions are the deliberate exception: an index of nothing but colliding
  // IDs is still the truth, and callers need it to answer "ambiguous" rather
  // than pretend the ID is unknown.
  if (size === 0 && collisions.length === 0) {
    console.error("[staff] 7shifts returned no usable punch IDs — keeping the previous index");
    return null;
  }

  const entries: string[] = [];
  for (const [punchId, staff] of Object.entries(index)) {
    entries.push(punchId, JSON.stringify(staff));
  }

  try {
    const pipeline = redis.multi();
    pipeline.del(INDEX_KEY);
    // hset with no field/value pairs is a syntax error at the wire.
    if (entries.length) pipeline.hset(INDEX_KEY, ...entries);
    pipeline.expire(INDEX_KEY, INDEX_TTL_SECONDS);
    pipeline.del(COLLISION_KEY);
    if (collisions.length) {
      pipeline.sadd(COLLISION_KEY, ...collisions);
      pipeline.expire(COLLISION_KEY, INDEX_TTL_SECONDS);
    }
    pipeline.set(FRESH_KEY, new Date().toISOString(), "EX", REFRESH_SECONDS);
    await pipeline.exec();
  } catch (e) {
    console.error("[staff] failed to publish punch index:", e instanceof Error ? e.message : e);
    return null;
  }

  if (collisions.length) {
    console.warn(
      `[staff] ${collisions.length} punch ID(s) held by more than one active employee and excluded: ${collisions.join(", ")}`,
    );
  }
  console.log(`[staff] punch index rebuilt — ${size} employees`);
  return { size, collisions };
}

/** Take the rebuild lock. False when somebody else is already rebuilding. */
async function takeRebuildLock(): Promise<boolean> {
  try {
    const res = await redis.set(LOCK_KEY, "1", "EX", REBUILD_LOCK_SECONDS, "NX");
    return res === "OK";
  } catch {
    // Redis unreachable — the caller's own reads are failing too; let it decide.
    return false;
  }
}

async function readIdentity(punchId: string): Promise<StaffIdentity | null> {
  try {
    const raw = await redis.hget(INDEX_KEY, punchId);
    if (!raw) return null;
    return JSON.parse(raw) as StaffIdentity;
  } catch {
    return null;
  }
}

async function isAmbiguous(punchId: string): Promise<boolean> {
  try {
    return (await redis.sismember(COLLISION_KEY, punchId)) === 1;
  } catch {
    return false;
  }
}

async function indexIsFresh(): Promise<boolean> {
  try {
    return (await redis.exists(FRESH_KEY)) === 1;
  } catch {
    return false;
  }
}

async function indexExists(): Promise<boolean> {
  try {
    return (await redis.exists(INDEX_KEY)) === 1;
  } catch {
    return false;
  }
}

/**
 * Resolve a typed punch ID.
 *
 * The flow, in the order it actually runs:
 *   hit                        → done, one Redis read
 *   miss + index fresh         → genuinely unknown, say so without touching 7shifts
 *   miss + index stale/absent  → rebuild once (if we win the lock), re-check
 *   no index and no rebuild    → "unavailable", so the caller can degrade
 *                                rather than lock a room out of its own tablet
 */
export async function verifyPunchId(rawPunchId: string): Promise<PunchVerifyResult> {
  const punchId = normalizePunchId(rawPunchId);
  if (!punchId) return { ok: false, reason: "unknown" };

  const hit = await readIdentity(punchId);
  if (hit) return { ok: true, staff: hit, stale: !(await indexIsFresh()) };

  if (await isAmbiguous(punchId)) return { ok: false, reason: "ambiguous" };

  // A miss against an index we know to be current is simply a wrong number.
  const had = await indexExists();
  if (had && (await indexIsFresh())) return { ok: false, reason: "unknown" };

  // Stale or cold: this may be somebody hired since the last build.
  if (await takeRebuildLock()) {
    await rebuildPunchIndex();
    const retry = await readIdentity(punchId);
    if (retry) return { ok: true, staff: retry, stale: false };
    if (await isAmbiguous(punchId)) return { ok: false, reason: "ambiguous" };
  }

  // Still nothing. If we have no index at all we cannot claim the ID is wrong.
  return { ok: false, reason: (await indexExists()) ? "unknown" : "unavailable" };
}
