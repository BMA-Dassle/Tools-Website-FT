import redis from "@/lib/redis";

/**
 * SMS quota / daily-limit handling.
 *
 * Voxtelesys (and the carriers behind it) enforce daily / hourly send caps.
 * When we hit one we get 429 with a body that often says "daily limit"
 * or "rate exceeded." The standard retry queue (3 attempts, max 10-min
 * backoff — see `lib/sms-retry.ts`) would burn through all attempts and
 * dead-letter every queued send before the limit reset window opened.
 *
 * This module provides a separate "quota queue" specifically for that
 * scenario:
 *
 *   1. When voxSend sees a quota error, it marks `sms:quota:exhausted`
 *      with a 1-hour TTL and pushes the failed send onto
 *      `sms:quota:queue` (sorted set, FIFO by Date.now()).
 *   2. While the flag is set, voxSend short-circuits — it doesn't even
 *      hit the API. Callers that try to send during cooldown get
 *      `{ ok:false, skipped:true }` and are expected to enqueue.
 *   3. The every-minute retry-sweep cron calls `drainQuotaQueue` after
 *      its normal drain. If the flag's TTL has expired, drain pulls
 *      everything FIFO and tries to send. First quota-error stops the
 *      drain and re-marks the flag (another 1h cooldown).
 *
 * 1-hour cooldown is intentionally pessimistic — actual carrier resets
 * vary (midnight UTC, midnight PT, rolling 24h, hourly buckets). One
 * hour buys us "we'll catch the reset within ~60 minutes" without
 * requiring us to know the exact reset clock.
 */

const QUOTA_KEY = "sms:quota:exhausted";
const QUOTA_QUEUE = "sms:quota:queue";
const QUOTA_TTL_SEC = 60 * 60; // 1 hour cooldown between drain attempts
const QUEUE_TTL_SEC = 60 * 60 * 24 * 7; // 7-day safety cap on the queue itself

/**
 * One queued send. The shape is intentionally narrow — we serialize
 * the body verbatim so no template / signed-URL regeneration happens
 * at drain time. If the body contains a signed URL with a TTL shorter
 * than the queue lifetime, that's the caller's problem; for our
 * confirmation links the signed URL TTL is well over a week, so this
 * is fine in practice.
 */
export interface QueuedSend {
  /** Canonical E.164 destination */
  phone: string;
  /** Body verbatim — we do not re-render */
  body: string;
  /** Optional Voxtelesys From override; falls back to default if omitted */
  from?: string;
  /** Origin tag — propagated into sms-log when the send eventually succeeds */
  source: "pre-race-cron" | "checkin-cron" | "booking-confirm" | "level-up" | "video-match" | "admin-resend" | "other";
  /** ISO timestamp of original (failed) attempt */
  queuedAt: string;
  /** Cross-reference for ticket / short-link audits */
  shortCode?: string;
  /** Cron-style audit info — preserved so dedup keys can be set on success */
  audit?: {
    sessionIds?: (string | number)[];
    personIds?: (string | number)[];
    memberCount?: number;
  };
  /** Optional fallback prefix for fromOverride degradation (matches voxSend opts) */
  fallbackPrefix?: string;
}

/** True if we're currently in a quota-cooldown window. */
export async function isQuotaExhausted(): Promise<boolean> {
  return !!(await redis.get(QUOTA_KEY));
}

/** Read the cooldown details (when hit, last status/error) — for admin / debug. */
export async function readQuotaStatus(): Promise<{ hitAt: string; status: number | null; error: string } | null> {
  const raw = await redis.get(QUOTA_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Mark quota exhausted. 1-hour TTL — drain retries hourly until success. */
export async function markQuotaExhausted(status: number | null, error: string): Promise<void> {
  await redis.set(
    QUOTA_KEY,
    JSON.stringify({
      hitAt: new Date().toISOString(),
      status,
      error: (error || "").slice(0, 200),
    }),
    "EX",
    QUOTA_TTL_SEC,
  );
}

/** Manually clear the cooldown flag (e.g. operator unblocking). */
export async function clearQuotaFlag(): Promise<void> {
  await redis.del(QUOTA_KEY);
}

/** Push a send onto the quota queue. Score = Date.now() so drain is FIFO. */
export async function quotaEnqueue(entry: QueuedSend): Promise<void> {
  await redis.zadd(QUOTA_QUEUE, Date.now(), JSON.stringify(entry));
  // Refresh queue TTL on each enqueue so an active queue never gets reaped.
  await redis.expire(QUOTA_QUEUE, QUEUE_TTL_SEC);
}

/** Number of queued sends currently waiting on quota reset. */
export async function quotaQueueSize(): Promise<number> {
  return await redis.zcard(QUOTA_QUEUE);
}

/** Peek at the head of the queue (oldest first) for admin display. */
export async function quotaPeek(max = 50): Promise<QueuedSend[]> {
  const raws = await redis.zrange(QUOTA_QUEUE, 0, max - 1);
  const out: QueuedSend[] = [];
  for (const r of raws) {
    try { out.push(JSON.parse(r) as QueuedSend); } catch { /* skip corrupt */ }
  }
  return out;
}

/**
 * Heuristic — true if a Voxtelesys response looks like a daily / hourly
 * cap. We're permissive on purpose: better to over-queue (and drain
 * quickly when limits clear) than to dead-letter recoverable sends.
 */
export function isQuotaError(status: number | null, body: string): boolean {
  if (status === 429) return true;
  const lower = (body || "").toLowerCase();
  if (lower.includes("daily limit")) return true;
  if (lower.includes("daily cap")) return true;
  if (lower.includes("quota")) return true;
  if (lower.includes("rate limit")) return true;
  if (lower.includes("too many requests")) return true;
  return false;
}

/**
 * Drain queued sends FIFO. Caller provides a `send` function — we don't
 * import voxSend here to avoid a circular dependency with sms-retry.ts.
 *
 * On the first quota-error encountered we re-mark the flag and stop —
 * the rest of the queue stays put for the next sweep tick.
 */
export async function drainQuotaQueue(
  send: (e: QueuedSend) => Promise<{ ok: boolean; status: number | null; error?: string }>,
  opts?: { max?: number },
): Promise<{ attempted: number; ok: number; abandoned: number; stoppedOnQuota: boolean; pendingAfter: number }> {
  // Don't burn API quota probing for status during cooldown.
  if (await isQuotaExhausted()) {
    return { attempted: 0, ok: 0, abandoned: 0, stoppedOnQuota: false, pendingAfter: await quotaQueueSize() };
  }
  const max = opts?.max ?? 100;
  const raws = await redis.zrange(QUOTA_QUEUE, 0, max - 1);
  let ok = 0, abandoned = 0;
  let stoppedOnQuota = false;
  for (const raw of raws) {
    let entry: QueuedSend;
    try {
      entry = JSON.parse(raw) as QueuedSend;
    } catch {
      // Corrupt entry — drop it.
      await redis.zrem(QUOTA_QUEUE, raw);
      abandoned++;
      continue;
    }
    let result;
    try {
      result = await send(entry);
    } catch (err) {
      result = { ok: false, status: null as number | null, error: err instanceof Error ? err.message : "send threw" };
    }
    if (result.ok) {
      await redis.zrem(QUOTA_QUEUE, raw);
      ok++;
      continue;
    }
    if (isQuotaError(result.status, result.error || "")) {
      // Quota still locked — re-mark and bail. Leave this entry + the rest queued.
      await markQuotaExhausted(result.status, result.error || "");
      stoppedOnQuota = true;
      break;
    }
    // Permanent / unrecoverable failure (bad number, body too long, etc).
    // The original retry queue already gave it 3 tries — we drop on first
    // non-quota failure here rather than spinning forever.
    await redis.zrem(QUOTA_QUEUE, raw);
    abandoned++;
  }
  return { attempted: raws.length, ok, abandoned, stoppedOnQuota, pendingAfter: await quotaQueueSize() };
}
