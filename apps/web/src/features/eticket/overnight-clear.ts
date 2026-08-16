/**
 * E-ticket overnight clear — the 2–5am ET failsafe behind the quiet-hours
 * gate (owner ask 2026-08-16: queued e-tickets must never send after
 * business hours).
 *
 * The quiet-hours gate HOLDS queued e-ticket sends overnight; this cron
 * PURGES them so nothing stale flushes at 8am. Every purged entry gets an
 * sms-log audit row (same source it queued under, error =
 * ETICKET_EXPIRED_ERROR) so the admin e-tickets board shows WHY a guest's
 * ticket never sent, with shortCode + body preserved for a manual resend.
 *
 * Sibling of wallet-overnight-clear: the schedule fires 07:20Z + 08:20Z
 * year-round; the in-code 2–5am ET gate exists so a manual curl or
 * misconfigured schedule can never wipe the daytime queues. Note BOTH
 * nightly firings usually land inside the window (3:20+4:20am EDT,
 * 2:20+3:20am EST) — the purge is idempotent (zrem-guarded, one audit
 * row per removed entry) and the quiet-hours gate stops new e-ticket
 * enqueues between them, so the second firing is a no-op. Keep any
 * future work added here idempotent for the same reason.
 */

import { purgeRetries, type RetryEntry } from "@/lib/sms-retry";
import { purgeQuotaQueue, type QueuedSend } from "@/lib/sms-quota";
import { logSms } from "@/lib/sms-log";
import { ETICKET_EXPIRED_ERROR, isEticketSource } from "./quiet-hours";

/** Kill switch only — ON unless explicitly disabled (owner rule 2026-07-31). */
export function overnightClearEnabled(): boolean {
  return process.env.ETICKET_OVERNIGHT_CLEAR !== "false";
}

export function etHour(now: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }).format(now),
  );
}

/** Same window as wallet-overnight-clear: only act 2–5am ET. */
export function overnightWindowOpen(now: Date = new Date()): boolean {
  const h = etHour(now);
  return h >= 2 && h <= 5;
}

export interface OvernightClearSummary {
  retriesCleared: number;
  quotaCleared: number;
  /** Purged entries, for the dryRun report + response payload. */
  cleared: { queue: "retry" | "quota"; source: string; phone: string; shortCode?: string }[];
}

async function auditRow(params: {
  phone: string;
  source: string;
  body: string;
  sessionIds?: (string | number)[];
  personIds?: (string | number)[];
  memberCount?: number;
  shortCode?: string;
}): Promise<void> {
  try {
    await logSms({
      ts: new Date().toISOString(),
      phone: params.phone,
      // Sources here are always the four e-ticket cron tags — already in
      // the SmsLogEntry union and the admin board's source allowlist.
      source: params.source as Parameters<typeof logSms>[0]["source"],
      status: null,
      ok: false,
      error: ETICKET_EXPIRED_ERROR,
      body: params.body,
      sessionIds: params.sessionIds,
      personIds: params.personIds,
      memberCount: params.memberCount,
      shortCode: params.shortCode,
    });
  } catch (err) {
    console.error("[eticket-overnight-clear] audit log failed:", err);
  }
}

/**
 * Purge every queued e-ticket send from the retry + quota queues, with
 * one audit row each. dryRun reports what WOULD clear without touching
 * either queue.
 */
export async function runEticketOvernightClear(opts: {
  dryRun: boolean;
}): Promise<OvernightClearSummary> {
  const cleared: OvernightClearSummary["cleared"] = [];

  if (opts.dryRun) {
    // Peek without removing: reuse the purge predicates against listers.
    const { listPending } = await import("@/lib/sms-retry");
    const { quotaPeek } = await import("@/lib/sms-quota");
    const [pending, quota] = await Promise.all([listPending(1000), quotaPeek(1000)]);
    for (const e of pending.filter((e) => isEticketSource(e.cron))) {
      cleared.push({
        queue: "retry",
        source: e.cron,
        phone: e.phone,
        shortCode: e.audit.shortCode,
      });
    }
    for (const e of quota.filter((e) => isEticketSource(e.source))) {
      cleared.push({ queue: "quota", source: e.source, phone: e.phone, shortCode: e.shortCode });
    }
    return {
      retriesCleared: cleared.filter((c) => c.queue === "retry").length,
      quotaCleared: cleared.filter((c) => c.queue === "quota").length,
      cleared,
    };
  }

  const retries: RetryEntry[] = await purgeRetries((e) => isEticketSource(e.cron));
  for (const e of retries) {
    await auditRow({
      phone: e.phone,
      source: e.cron,
      body: e.body,
      sessionIds: e.audit.sessionIds,
      personIds: e.audit.personIds,
      memberCount: e.audit.memberCount,
      shortCode: e.audit.shortCode,
    });
    cleared.push({ queue: "retry", source: e.cron, phone: e.phone, shortCode: e.audit.shortCode });
  }

  const quota: QueuedSend[] = await purgeQuotaQueue((e) => isEticketSource(e.source));
  for (const e of quota) {
    await auditRow({
      phone: e.phone,
      source: e.source,
      body: e.body,
      sessionIds: e.audit?.sessionIds,
      personIds: e.audit?.personIds,
      memberCount: e.audit?.memberCount,
      shortCode: e.shortCode,
    });
    cleared.push({ queue: "quota", source: e.source, phone: e.phone, shortCode: e.shortCode });
  }

  return { retriesCleared: retries.length, quotaCleared: quota.length, cleared };
}
