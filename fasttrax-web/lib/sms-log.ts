import redis from "@/lib/redis";

/**
 * Persistent SMS log — one entry per Voxtelesys call, success or failure.
 *
 * Redis layout:
 *   sms:log:{YYYY-MM-DD} — LIST (LPUSH, so index 0 = most recent), 90-day TTL.
 *
 * Call `logSms({...})` from every SMS send path. Query via /api/sms-log.
 * No PII scrubbing — this is internal auditing for operators.
 */

export interface SmsLogEntry {
  /** ISO timestamp of the send attempt */
  ts: string;
  /** Canonical E.164 phone (e.g. +12395551234) */
  phone: string;
  /** Which cron / code path fired this */
  source: "pre-race-cron" | "checkin-cron" | "booking-confirm" | "level-up" | "other";
  /** Voxtelesys HTTP status, or null if we didn't reach the API */
  status: number | null;
  /** true iff Voxtelesys accepted the send (res.ok) */
  ok: boolean;
  /** Voxtelesys error body (first 500 chars) when ok=false */
  error?: string;
  /** Racer sessionIds this SMS covers (grouped SMS may cover multiple) */
  sessionIds?: (string | number)[];
  /** Racer personIds this SMS covers */
  personIds?: (string | number)[];
  /** Number of racers in this SMS (1 = single, >1 = grouped) */
  memberCount?: number;
  /** Short URL code (from /s/{code}) for cross-reference to the ticket */
  shortCode?: string;
  /** Full outgoing SMS body */
  body?: string;
}

const LOG_TTL = 60 * 60 * 24 * 90; // 90 days
const MAX_PER_DAY = 10_000;

function dayKey(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d); // YYYY-MM-DD
  return `sms:log:${parts}`;
}

export async function logSms(entry: SmsLogEntry): Promise<void> {
  try {
    const key = dayKey(entry.ts);
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, MAX_PER_DAY - 1);
    await redis.expire(key, LOG_TTL);
  } catch (err) {
    // Logging failures must never interrupt SMS flow.
    console.error("[sms-log] write failed:", err);
  }
}

export async function readSmsLog(
  dateYmdEt: string,
  { limit = 200, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<SmsLogEntry[]> {
  const raw = await redis.lrange(`sms:log:${dateYmdEt}`, offset, offset + limit - 1);
  const out: SmsLogEntry[] = [];
  for (const s of raw) {
    try { out.push(JSON.parse(s) as SmsLogEntry); } catch { /* skip corrupt entry */ }
  }
  return out;
}
