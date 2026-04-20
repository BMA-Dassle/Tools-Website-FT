import redis from "@/lib/redis";
import { randomBytes } from "crypto";
import { canonicalizePhone } from "@/lib/participant-contact";
import { logSms } from "@/lib/sms-log";

/**
 * SMS retry queue — failed sends get re-attempted on subsequent cron ticks
 * with exponential backoff, up to MAX_ATTEMPTS. Entries that exhaust retries
 * are moved to a dead-letter list for manual review.
 *
 * Redis layout:
 *   sms:retry:pending   SORTED SET  (score = unix-ms retry-after)
 *     member = JSON blob (see RetryEntry)
 *   sms:retry:dead      LIST (LPUSH newest-first), 90-day TTL
 *
 * Flow:
 *   queueRetry(entry)   — called from sendSms on failure
 *   drainRetryQueue(cron, send) — called at the top of each cron fire;
 *     pulls due entries, attempts via `send(phone, body, audit)`, on success
 *     the caller's retry wrapper sets dedup keys; on failure re-queues with
 *     longer backoff or moves to dead.
 */

export type SmsRetryCron = "pre-race-cron" | "checkin-cron";

export interface SmsRetryAudit {
  sessionIds: (string | number)[];
  personIds: (string | number)[];
  memberCount: number;
  shortCode?: string;
}

export interface RetryEntry {
  id: string;
  cron: SmsRetryCron;
  phone: string;       // canonical +1...
  body: string;
  audit: SmsRetryAudit;
  attempts: number;
  firstFailedAt: string;
  lastFailedAt: string;
  lastStatus: number | null;
  lastError: string;
}

const PENDING = "sms:retry:pending";
const DEAD = "sms:retry:dead";
const DEAD_TTL = 60 * 60 * 24 * 90;
const MAX_ATTEMPTS = 3;

/** Exponential-ish backoff: 30s, 2m, 10m for attempts 1..3. */
function backoffMsFor(attempt: number): number {
  if (attempt <= 1) return 30_000;
  if (attempt === 2) return 120_000;
  return 600_000;
}

function newId(): string {
  return randomBytes(6).toString("base64url").slice(0, 10);
}

/**
 * Queue a failed send for retry. Called from sendSms when Voxtelesys
 * returns non-2xx or throws.
 */
export async function queueRetry(params: {
  cron: SmsRetryCron;
  phone: string;
  body: string;
  audit: SmsRetryAudit;
  status: number | null;
  error: string;
}): Promise<void> {
  try {
    const now = new Date().toISOString();
    const entry: RetryEntry = {
      id: newId(),
      cron: params.cron,
      phone: params.phone,
      body: params.body,
      audit: params.audit,
      attempts: 0,
      firstFailedAt: now,
      lastFailedAt: now,
      lastStatus: params.status,
      lastError: (params.error || "").slice(0, 500),
    };
    const retryAt = Date.now() + backoffMsFor(1);
    await redis.zadd(PENDING, retryAt, JSON.stringify(entry));
  } catch (err) {
    console.error("[sms-retry] queueRetry failed:", err);
  }
}

/**
 * Pull all entries whose retry-after has passed AND that target this cron.
 * Returns them with the raw Redis member string so the caller can remove
 * them on success.
 */
export async function dueRetries(cron: SmsRetryCron, now = Date.now()): Promise<{ raw: string; entry: RetryEntry }[]> {
  const raws = await redis.zrangebyscore(PENDING, 0, now);
  const out: { raw: string; entry: RetryEntry }[] = [];
  for (const r of raws) {
    try {
      const entry = JSON.parse(r) as RetryEntry;
      if (entry.cron === cron) out.push({ raw: r, entry });
    } catch { /* skip corrupt */ }
  }
  return out;
}

/**
 * Remove a pending retry (on success).
 */
export async function removeRetry(raw: string): Promise<void> {
  await redis.zrem(PENDING, raw);
}

/**
 * Re-queue (on another failure) with longer backoff, or move to dead if
 * MAX_ATTEMPTS reached. Returns true if moved to dead.
 */
export async function reQueueOrDead(
  raw: string,
  entry: RetryEntry,
  status: number | null,
  error: string,
): Promise<boolean> {
  await redis.zrem(PENDING, raw);
  const nextAttempts = entry.attempts + 1;
  const updated: RetryEntry = {
    ...entry,
    attempts: nextAttempts,
    lastFailedAt: new Date().toISOString(),
    lastStatus: status,
    lastError: (error || "").slice(0, 500),
  };
  if (nextAttempts >= MAX_ATTEMPTS) {
    await redis.lpush(DEAD, JSON.stringify(updated));
    await redis.expire(DEAD, DEAD_TTL);
    return true;
  }
  const retryAt = Date.now() + backoffMsFor(nextAttempts + 1);
  await redis.zadd(PENDING, retryAt, JSON.stringify(updated));
  return false;
}

/**
 * Count of pending retries across all crons (for dashboards).
 */
export async function pendingCount(): Promise<number> {
  return await redis.zcard(PENDING);
}

export async function listPending(max = 200): Promise<RetryEntry[]> {
  const raws = await redis.zrange(PENDING, 0, max - 1);
  const out: RetryEntry[] = [];
  for (const r of raws) {
    try { out.push(JSON.parse(r) as RetryEntry); } catch { /* skip */ }
  }
  return out;
}

export async function listDead(max = 200): Promise<RetryEntry[]> {
  const raws = await redis.lrange(DEAD, 0, max - 1);
  const out: RetryEntry[] = [];
  for (const r of raws) {
    try { out.push(JSON.parse(r) as RetryEntry); } catch { /* skip */ }
  }
  return out;
}

/**
 * Voxtelesys send — shared by both crons + the sweep so retries don't
 * duplicate the HTTP call.
 *
 * Throttled to MIN_VOX_SPACING_MS between consecutive calls within the same
 * runtime instance, to stay under Voxtelesys's per-second burst cap. This
 * eliminates 429s at the source rather than relying on the retry queue to
 * absorb them. Module-scoped, so every call path (main send, retry drain,
 * sweep) naturally serializes against the same clock.
 */
const MIN_VOX_SPACING_MS = 150;
let lastVoxSendAt = 0;

async function voxThrottle(): Promise<void> {
  const sinceLast = Date.now() - lastVoxSendAt;
  if (sinceLast < MIN_VOX_SPACING_MS) {
    await new Promise((r) => setTimeout(r, MIN_VOX_SPACING_MS - sinceLast));
  }
  lastVoxSendAt = Date.now();
}

export interface VoxSendOpts {
  /**
   * Override the Voxtelesys From number for this message (E.164, e.g. "+12392148353").
   * Falls back to VOX_FROM when omitted. If Voxtelesys rejects the override with
   * 400/403 (DID not owned by our account), we retry once with VOX_FROM and
   * `fallbackPrefix` prepended to the body — so the customer still sees who it's from.
   */
  fromOverride?: string;
  /** Prefix prepended on fallback, e.g. "From Stephanie (direct: 239-214-8353): ". */
  fallbackPrefix?: string;
}

const VOX_FROM = "+12394819666";

async function voxSendOnce(
  toFormatted: string,
  body: string,
  fromNumber: string,
): Promise<{ ok: boolean; status: number | null; error?: string }> {
  const VOX_API_KEY = process.env.VOX_API_KEY || "";
  if (!VOX_API_KEY) return { ok: false, status: null, error: "VOX_API_KEY missing" };

  await voxThrottle();

  try {
    const res = await fetch("https://smsapi.voxtelesys.net/api/v2/sms", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${VOX_API_KEY}`,
      },
      body: JSON.stringify({ to: toFormatted, from: fromNumber, body }),
    });
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 500);
      return { ok: false, status: res.status, error: errText };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : "network error" };
  }
}

export async function voxSend(
  toFormatted: string,
  body: string,
  opts?: VoxSendOpts,
): Promise<{ ok: boolean; status: number | null; error?: string }> {
  const from = opts?.fromOverride || VOX_FROM;
  const result = await voxSendOnce(toFormatted, body, from);

  // If we tried with an override and Voxtelesys rejected it (likely DID not owned),
  // degrade to default VOX_FROM and prepend a "From {planner}" prefix so the
  // customer still knows who's texting.
  if (
    !result.ok &&
    opts?.fromOverride &&
    (result.status === 400 || result.status === 403)
  ) {
    const prefix = opts.fallbackPrefix || `(From ${opts.fromOverride}) `;
    const fallbackBody = prefix + body;
    return await voxSendOnce(toFormatted, fallbackBody, VOX_FROM);
  }

  return result;
}

/**
 * Drain pending retries for a given cron. On success sets the cron's dedup
 * keys for every (sessionId, personId) the SMS covered. Used by both the
 * main cron handlers and the dedicated retry-sweep cron — sweep runs every
 * minute so 5-minute pre-race gaps don't strand retries.
 */
export async function drainRetries(
  cron: SmsRetryCron,
): Promise<{ attempted: number; ok: number; requeued: number; dead: number }> {
  const DEDUP_TTL_PRE_RACE = 60 * 60 * 24;
  const DEDUP_TTL_CHECKIN = 60 * 60 * 6;
  const prefix = cron === "pre-race-cron" ? "alert:pre-race" : "alert:checkin";
  const dedupTtl = cron === "pre-race-cron" ? DEDUP_TTL_PRE_RACE : DEDUP_TTL_CHECKIN;

  const due = await dueRetries(cron);
  let ok = 0, requeued = 0, dead = 0;
  for (const { raw, entry } of due) {
    const toFormatted = canonicalizePhone(entry.phone);
    if (!toFormatted) { await removeRetry(raw); continue; }
    const ts = new Date().toISOString();
    const result = await voxSend(toFormatted, entry.body);
    if (result.ok) {
      await removeRetry(raw);
      await logSms({
        ts, phone: toFormatted, source: cron,
        status: result.status, ok: true, body: entry.body,
        sessionIds: entry.audit.sessionIds, personIds: entry.audit.personIds,
        memberCount: entry.audit.memberCount, shortCode: entry.audit.shortCode,
      });
      for (const sid of entry.audit.sessionIds) {
        for (const pid of entry.audit.personIds) {
          await redis.set(`${prefix}:${sid}:${pid}`, "1", "EX", dedupTtl);
        }
      }
      ok++;
    } else {
      await logSms({
        ts, phone: toFormatted, source: cron,
        status: result.status, ok: false,
        error: `[retry attempt ${entry.attempts + 1}] ${result.error}`, body: entry.body,
        sessionIds: entry.audit.sessionIds, personIds: entry.audit.personIds,
        memberCount: entry.audit.memberCount, shortCode: entry.audit.shortCode,
      });
      const movedToDead = await reQueueOrDead(raw, entry, result.status, result.error || "");
      if (movedToDead) dead++; else requeued++;
    }
  }
  return { attempted: due.length, ok, requeued, dead };
}
