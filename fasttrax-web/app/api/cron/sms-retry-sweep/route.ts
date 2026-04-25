import { NextRequest, NextResponse } from "next/server";
import { drainRetries, pendingCount, voxSend } from "@/lib/sms-retry";
import { drainQuotaQueue, quotaQueueSize, isQuotaExhausted, type QueuedSend } from "@/lib/sms-quota";
import { logSms, logCronRun } from "@/lib/sms-log";

/**
 * SMS retry sweep — runs every minute to drain due retries across BOTH crons,
 * then drains the quota queue for sends backed up behind a daily / hourly cap.
 *
 * Without this, a retry queued from a pre-race failure could sit up to 5
 * minutes before the pre-race cron next fires. The sweep catches retries
 * the instant their retry-after has passed.
 *
 * Quota behavior: if a daily limit is hit, voxSend marks a 1-hour cooldown
 * flag and stops trying. The sweep checks the flag — if cleared (i.e. quota
 * window has reset), it FIFO-drains the quota queue, sending each backlog
 * SMS one at a time. First quota-error stops the drain and re-marks the
 * cooldown for another hour.
 *
 * Cron schedule: `* * * * *` (every minute) in vercel.json.
 */
export async function GET(req: NextRequest) {
  const started = Date.now();
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  try {
    const [preRace, checkin, pending] = await Promise.all([
      dryRun ? Promise.resolve({ attempted: 0, ok: 0, requeued: 0, dead: 0, quotaQueued: 0 }) : drainRetries("pre-race-cron"),
      dryRun ? Promise.resolve({ attempted: 0, ok: 0, requeued: 0, dead: 0, quotaQueued: 0 }) : drainRetries("checkin-cron"),
      pendingCount(),
    ]);

    // Quota queue drain — only fires when the cooldown flag has expired.
    // Each successful send becomes its own logSms entry tagged with the
    // original source so admin reports stay coherent.
    const quotaCooldownActive = await isQuotaExhausted();
    const quota = (dryRun || quotaCooldownActive)
      ? { attempted: 0, ok: 0, abandoned: 0, stoppedOnQuota: false, pendingAfter: await quotaQueueSize() }
      : await drainQuotaQueue(async (entry: QueuedSend) => {
          const result = await voxSend(entry.phone, entry.body, entry.from ? { fromOverride: entry.from, fallbackPrefix: entry.fallbackPrefix } : undefined);
          // Log each drained attempt so the audit trail stays complete —
          // success goes in as a normal entry, failure carries a "[quota-drain]"
          // tag so it's easy to filter in the admin tool.
          await logSms({
            ts: new Date().toISOString(),
            phone: entry.phone,
            source: entry.source,
            status: result.status,
            ok: result.ok,
            error: result.ok ? undefined : `[quota-drain] ${result.error || "unknown"}`,
            body: entry.body,
            sessionIds: entry.audit?.sessionIds,
            personIds: entry.audit?.personIds,
            memberCount: entry.audit?.memberCount,
            shortCode: entry.shortCode,
            provider: result.provider,
            failedOver: result.failedOver,
          });
          // Video-match records carry their own SMS-state mirror
          // (notifySmsOk + notifySmsError) on the saved match. On
          // successful drain we patch those fields so the /admin/videos
          // board flips from grey "sms ⏳ queued" to green "sms ✓"
          // immediately (no need to wait for the next video-match
          // cron tick). shortCode is the videoCode for video-match
          // entries — see lib/video-notify.ts.
          if (result.ok && entry.source === "video-match" && entry.shortCode) {
            try {
              const { getMatchByVideoCode, updateVideoMatch } = await import("@/lib/video-match");
              const match = await getMatchByVideoCode(entry.shortCode);
              if (match) {
                match.notifySmsOk = true;
                match.notifySmsError = undefined;
                match.notifySmsSentTo = entry.phone;
                match.notifySmsSentAt = new Date().toISOString();
                await updateVideoMatch(match);
              }
            } catch (err) {
              console.warn("[sms-retry-sweep] video-match patch failed:", err);
            }
          }
          return { ok: result.ok, status: result.status, error: result.error };
        });

    const sent = preRace.ok + checkin.ok + quota.ok;
    const errors = preRace.requeued + checkin.requeued + preRace.dead + checkin.dead + quota.abandoned;

    await logCronRun({
      ts: new Date().toISOString(),
      cron: "checkin", // nearest existing bucket — extend CronRunEntry type later if we need a dedicated "sweep" category
      dryRun,
      elapsedMs: Date.now() - started,
      invoker: req.headers.get("x-vercel-cron") ? "vercel-cron" : (req.headers.get("user-agent") || "unknown"),
      candidates: preRace.attempted + checkin.attempted + quota.attempted,
      sent,
      skipped: 0,
      errors,
    });

    return NextResponse.json({
      ok: true,
      dryRun,
      elapsedMs: Date.now() - started,
      preRace,
      checkin,
      quota,
      quotaCooldownActive,
      pendingAfter: pending,
    });
  } catch (err) {
    console.error("[sms-retry-sweep] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sweep error" },
      { status: 500 },
    );
  }
}
