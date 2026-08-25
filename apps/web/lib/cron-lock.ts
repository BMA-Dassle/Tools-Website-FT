import { randomUUID } from "crypto";
import redis from "@/lib/redis";

/**
 * A Redis mutex so a slow cron run cannot overlap its own next tick.
 *
 * WHY. Vercel fires a cron on a schedule; it does not care whether the previous
 * run finished. `group-quote-dispatch` was measured at 58-66s live on a 60s
 * schedule (2026-08-25), so runs were genuinely on top of each other — two
 * copies reading the same year of dayPlanner and racing to move the same BMI
 * project. Halving the cadence made that unlikely; a lock makes it impossible,
 * which is what you want for a job that writes contracts and moves state.
 *
 * SHAPE. `SET key token NX EX ttl` — the standard single-node lock. Released
 * only by the holder: a run that overran its TTL must NOT delete a lock the
 * next run already owns, so release compares the token first.
 *
 * TTL is a backstop, not a promise. Pick it a little above the worst observed
 * runtime: too short and a slow run stops excluding, too long and a crashed run
 * blocks the job until it lapses. A killed lambda cannot run its own `finally`,
 * which is exactly why there is a TTL at all.
 *
 * A Redis outage FAILS OPEN — it runs the job unlocked rather than silently
 * parking a cron that recovers bookings and sends contracts. Overlap is a
 * performance problem; a cron that quietly stops is an outage.
 */
export interface CronLockResult<T> {
  /** False when another run held the lock and this tick did nothing. */
  ran: boolean;
  /** Present only when `ran` is true. */
  result?: T;
  /** True when the lock could not be consulted and the job ran anyway. */
  degraded?: boolean;
}

export async function withCronLock<T>(
  name: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<CronLockResult<T>> {
  const key = `cron:lock:${name}`;
  const token = randomUUID();

  let held = false;
  let degraded = false;
  try {
    // ioredis: SET key value EX <ttl> NX → "OK" when acquired, null when held.
    const acquired = await redis.set(key, token, "EX", ttlSeconds, "NX");
    held = acquired === "OK";
  } catch (err) {
    degraded = true;
    console.warn(
      `[cron-lock] ${name}: Redis unavailable, running unlocked —`,
      err instanceof Error ? err.message : err,
    );
  }

  if (!held && !degraded) {
    console.log(`[cron-lock] ${name}: previous run still in flight, skipping this tick`);
    return { ran: false };
  }

  try {
    return { ran: true, result: await fn(), ...(degraded ? { degraded: true } : {}) };
  } finally {
    if (held) {
      try {
        // Only if we still own it — see the release note above.
        const current = await redis.get(key);
        if (current === token) await redis.del(key);
      } catch {
        // Non-fatal: the TTL clears it.
      }
    }
  }
}
