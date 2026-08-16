/**
 * Shared quota-queue triage for e-ticket entries — used by EVERY
 * drainQuotaQueue caller (the sms-retry-sweep cron AND the admin
 * "clear-and-drain" button), so the quiet-hours + staleness guarantees
 * hold no matter who triggers the drain. (Review finding 2026-08-16:
 * the admin drain originally bypassed the sweep's private triage, so an
 * operator recovering from a quota outage at 12:30am would have flushed
 * stale "NOW CHECKING IN" texts overnight.)
 */

import redis from "@/lib/redis";
import { logSms } from "@/lib/sms-log";
import { bmiKeyScope } from "@/lib/bmi-key-scope";
import type { QueuedSend, QuotaDrainVerdict } from "@/lib/sms-quota";
import {
  ETICKET_EXPIRED_ERROR,
  inEticketQuietHours,
  isEticketSource,
  maxQueueAgeMs,
} from "./quiet-hours";

/**
 * Hold e-ticket entries during quiet hours (the overnight clear purges +
 * audits them), drop them once stale enough that the message would be
 * wrong even in business hours. Every other source (booking
 * confirmations, video links, ...) drains normally — the quiet-hours
 * guarantee is scoped to e-tickets.
 */
export function eticketQuotaTriage(entry: QueuedSend): QuotaDrainVerdict {
  if (!isEticketSource(entry.source)) return "send";
  if (inEticketQuietHours()) return "hold";
  const ageMs = Date.now() - new Date(entry.queuedAt).getTime();
  if (Number.isFinite(ageMs) && ageMs > maxQueueAgeMs(entry.source)) return "drop";
  return "send";
}

/**
 * Audit row for a dropped-at-drain e-ticket — same shape the overnight
 * clear writes, so the admin board's "expired in queue" pill covers both
 * paths and the row stays manually resendable (shortCode + body kept).
 */
export async function logExpiredQuotaEntry(entry: QueuedSend): Promise<void> {
  await logSms({
    ts: new Date().toISOString(),
    phone: entry.phone,
    source: entry.source,
    status: null,
    ok: false,
    error: ETICKET_EXPIRED_ERROR,
    body: entry.body,
    sessionIds: entry.audit?.sessionIds,
    personIds: entry.audit?.personIds,
    memberCount: entry.audit?.memberCount,
    shortCode: entry.shortCode,
  });
}

/** Dedup prefix + TTL per e-ticket source — mirrors drainRetries' map. */
const DEDUP: Record<string, { prefix: string; ttl: number }> = {
  "pre-race-cron": { prefix: "alert:pre-race", ttl: 60 * 60 * 24 },
  "checkin-cron": { prefix: "alert:checkin", ttl: 60 * 60 * 6 },
  "arena-pre-cron": { prefix: "alert:arena-pre", ttl: 60 * 60 * 24 },
  "arena-checkin-cron": { prefix: "alert:arena-checkin", ttl: 60 * 60 * 6 },
};

/**
 * After a quota-drained e-ticket actually SENDS, rebuild the same
 * location-scoped dedup keys the cron scans check — exactly like
 * drainRetries does for the retry queue. Without this, the next cron
 * tick re-detects the recipient as fresh and re-sends (the quota queue
 * historically never wrote these; QueuedSend.locationId now closes it).
 */
export async function setDedupKeysForQuotaEntry(entry: QueuedSend): Promise<void> {
  const dedup = DEDUP[entry.source];
  if (!dedup) return; // non-eticket sources have no alert dedup keys
  const scope = bmiKeyScope(entry.locationId);
  for (const sid of entry.audit?.sessionIds ?? []) {
    for (const pid of entry.audit?.personIds ?? []) {
      try {
        await redis.set(`${dedup.prefix}:${scope}${sid}:${pid}`, "1", "EX", dedup.ttl);
      } catch {
        /* best-effort — a missed dedup key costs one duplicate, not a crash */
      }
    }
  }
}
