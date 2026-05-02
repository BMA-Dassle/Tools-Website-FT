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
  /** Which cron / code path fired this.
   *  `admin-resend` is a manual resend from the /admin/* tool — distinguish
   *  these in reports so they don't double-count real cron deliveries. */
  source: "pre-race-cron" | "checkin-cron" | "booking-confirm" | "level-up" | "admin-resend" | "video-match" | "other";
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
  /** Which SMS provider actually attempted/delivered this send. Defaults
   *  to "vox" when omitted (back-compat for entries logged before
   *  Twilio failover existed). */
  provider?: "vox" | "twilio";
  /** True when Vox returned a quota error and Twilio picked up the send.
   *  Lets the admin tool surface "Vox→Twilio failover" rows. */
  failedOver?: boolean;
  /** True when this SMS was routed to a guardian's contact (minor
   *  racer with no usable own contact). The admin board surfaces a
   *  "↻ via guardian" badge so staff can audit fallback rate. The
   *  `phone` field holds the actual destination (guardian's). */
  viaGuardian?: boolean;
  /** Provider message id captured at send time. Used by the
   *  status-callback webhook to correlate delivery state back to
   *  this log entry. Vox: 24-char hex. Twilio: SMxxxxx. */
  providerMessageId?: string;
  /** Real handset-delivery state, populated by the carrier callback
   *  (Vox: /api/sms-webhook/vox; Twilio webhook not yet wired). The
   *  send-time `ok` field only indicates "provider accepted"; this
   *  field tracks what actually happened to the message after.
   *
   *  Values mirror what the providers report:
   *    - "delivered"   — carrier confirmed handset receipt (DLR)
   *    - "undelivered" — carrier rejected (filtered, invalid, etc.)
   *    - "failed"      — provider gave up before carrier handoff
   *    - "sent"        — provider handed to carrier, no DLR yet
   *    - "queued"      — provider hasn't tried sending yet
   *    - undefined     — initial state, no callback received
   */
  deliveryStatus?: "delivered" | "undelivered" | "failed" | "sent" | "queued";
  /** Most recent delivery-status update timestamp (ISO). Lets the
   *  admin UI show "delivered 0:02 after send" or "no DLR after 5
   *  minutes — likely silently dropped". */
  deliveryUpdatedAt?: string;
  /** Provider error code on undelivered/failed (e.g. carrier
   *  filtered = 30007 on Twilio). Surfaces the actual reason in the
   *  admin log so operators can act (resend via different provider,
   *  contact carrier, etc.). */
  deliveryErrorCode?: string;
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
    // Index Vox message ids → day-key so the status callback can
    // find the entry to update (the per-day list is not random
    // access on providerMessageId; this index avoids a full scan).
    if (entry.providerMessageId && entry.provider !== "twilio") {
      const indexKey = `sms:log:idx:vox:${entry.providerMessageId}`;
      try {
        await redis.set(indexKey, key, "EX", LOG_TTL);
      } catch (err) {
        console.warn("[sms-log] index write failed:", err);
      }
    }
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

/**
 * Aggregate SMS counts per ET-day across an inclusive date range.
 *
 * Returns one entry per day with a breakdown by source category, keyed
 * to what the sales admin board surfaces:
 *   - bookingConfirm  ← `source: "booking-confirm"`     (booking confirmations)
 *   - eTicket         ← `source: "pre-race-cron"`        (pre-race e-ticket SMS)
 *   - checkIn         ← `source: "checkin-cron"`         (heat check-in alerts)
 *   - video           ← `source: "video-match"`          (race-video ready notifications)
 *   - other           ← anything else (admin-resend, level-up, other)
 *
 * Each per-day row also tracks `attempts` (every entry, ok or not) and
 * `delivered` (provider DLR confirmed `delivered`). `attempts - ok`
 * lets the dashboard surface failure rate.
 *
 * O(N) scan over each day's list — bounded by MAX_PER_DAY (10k), so
 * worst case ~10k entries per call. Fine for a dashboard refresh; no
 * indexing needed.
 */
export interface SmsDailyCounts {
  /** ISO date in ET, YYYY-MM-DD */
  date: string;
  /** Total log entries for the day (every send attempt) */
  attempts: number;
  /** Provider accepted (res.ok was true at send time) */
  ok: number;
  /** Carrier confirmed handset receipt (DLR = delivered) */
  delivered: number;
  /** Per-source breakdown of `attempts`. Other sources roll into `other`. */
  bySource: {
    bookingConfirm: number;
    eTicket: number;
    checkIn: number;
    video: number;
    other: number;
  };
}

/** Map a raw `source` field onto the dashboard's category buckets. */
function bucketSource(s: string | undefined): keyof SmsDailyCounts["bySource"] {
  switch (s) {
    case "booking-confirm":
      return "bookingConfirm";
    case "pre-race-cron":
      return "eTicket";
    case "checkin-cron":
      return "checkIn";
    case "video-match":
      return "video";
    default:
      return "other";
  }
}

/** ET-localized YYYY-MM-DD strings between `from` and `to` inclusive.
 *  Mirrors the dayKey() formatter so the keys we read are aligned to
 *  the same ET-bucketing the writer used. */
function etDateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // Anchor at midnight UTC of the from-date and walk forward day by day.
  // Comparing the formatted ET string lets us cleanly stop at `to`.
  let cursor = new Date(from + "T12:00:00Z");
  const end = fmt.format(new Date(to + "T12:00:00Z"));
  // Hard cap at 366 to avoid an unbounded loop on a malformed range.
  for (let i = 0; i < 366; i++) {
    const ymd = fmt.format(cursor);
    out.push(ymd);
    if (ymd === end) break;
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return out;
}

export async function readSmsCountsRange(
  fromYmdEt: string,
  toYmdEt: string,
): Promise<SmsDailyCounts[]> {
  const days = etDateRange(fromYmdEt, toYmdEt);
  const out: SmsDailyCounts[] = [];
  for (const ymd of days) {
    const key = `sms:log:${ymd}`;
    const raw = await redis.lrange(key, 0, -1);
    const counts: SmsDailyCounts = {
      date: ymd,
      attempts: 0,
      ok: 0,
      delivered: 0,
      bySource: {
        bookingConfirm: 0,
        eTicket: 0,
        checkIn: 0,
        video: 0,
        other: 0,
      },
    };
    for (const s of raw) {
      let e: SmsLogEntry;
      try {
        e = JSON.parse(s) as SmsLogEntry;
      } catch {
        continue;
      }
      counts.attempts++;
      if (e.ok) counts.ok++;
      if (e.deliveryStatus === "delivered") counts.delivered++;
      counts.bySource[bucketSource(e.source)]++;
    }
    out.push(counts);
  }
  return out;
}

/**
 * Cron-run log — one entry per cron invocation, regardless of whether any SMS
 * went out. Answers "did the cron actually fire?" when the SMS log is quiet.
 *
 * Redis: cron:log:{YYYY-MM-DD} LIST (LPUSH newest-first), 90-day TTL, capped
 * at 10k entries/day.
 */

export interface CronRunEntry {
  ts: string;
  cron: "pre-race" | "checkin" | "video-match";
  dryRun: boolean;
  elapsedMs: number;
  /** Caller IP / source (approximate — useful to distinguish Vercel cron vs manual curl) */
  invoker?: string;
  candidates: number;
  sent: number;
  skipped: number;
  errors: number;
  groupedSmsSends?: number;
  singleSmsSends?: number;
  emailSends?: number;
  /** For checkin: which sessions were in /races-current during this fire */
  sessions?: { track: string; sessionId: number; reason?: string }[];
  /** Free-form error if the cron itself threw */
  fatalError?: string;
}

export async function logCronRun(entry: CronRunEntry): Promise<void> {
  try {
    const key = dayKey(entry.ts);
    // reuse the sms:log day computation — different list name
    const cronKey = key.replace("sms:log:", "cron:log:");
    await redis.lpush(cronKey, JSON.stringify(entry));
    await redis.ltrim(cronKey, 0, MAX_PER_DAY - 1);
    await redis.expire(cronKey, LOG_TTL);
  } catch (err) {
    console.error("[cron-log] write failed:", err);
  }
}

export async function readCronLog(
  dateYmdEt: string,
  { limit = 200, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<CronRunEntry[]> {
  const raw = await redis.lrange(`cron:log:${dateYmdEt}`, offset, offset + limit - 1);
  const out: CronRunEntry[] = [];
  for (const s of raw) {
    try { out.push(JSON.parse(s) as CronRunEntry); } catch { /* skip */ }
  }
  return out;
}
