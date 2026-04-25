import { NextRequest, NextResponse } from "next/server";
import {
  isQuotaExhausted,
  readQuotaStatus,
  clearQuotaFlag,
  quotaQueueSize,
  quotaPeek,
  drainQuotaQueue,
  type QueuedSend,
} from "@/lib/sms-quota";
import { voxSend } from "@/lib/sms-retry";
import { logSms } from "@/lib/sms-log";

/**
 * GET  /api/admin/sms-quota
 *   Returns current cooldown state + queue head. Admin-gated by
 *   middleware (token + IP allowlist).
 *
 * POST /api/admin/sms-quota
 *   Body: { action: "clear" | "drain" | "clear-and-drain" }
 *   - clear: drops the cooldown flag so the next sweep cron tick
 *     (and any voxSend caller) tries Vox immediately. Use this once
 *     Voxtelesys reports they're back online.
 *   - drain: force-drain the queue right now. Equivalent to waiting
 *     up to a minute for the sms-retry-sweep cron, but immediate.
 *   - clear-and-drain: combo — drop the flag THEN drain. Most useful
 *     "we're back, push everything pending" button.
 */

export async function GET() {
  try {
    const [exhausted, status, size, head] = await Promise.all([
      isQuotaExhausted(),
      readQuotaStatus(),
      quotaQueueSize(),
      quotaPeek(50),
    ]);
    return NextResponse.json(
      { exhausted, status, queueSize: size, queue: head },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[admin/sms-quota GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const action: string = body.action || "";
    let cleared = false;
    let drainResult: { attempted: number; ok: number; abandoned: number; stoppedOnQuota: boolean; pendingAfter: number } | null = null;

    if (action === "clear" || action === "clear-and-drain") {
      await clearQuotaFlag();
      cleared = true;
    }

    if (action === "drain" || action === "clear-and-drain") {
      drainResult = await drainQuotaQueue(async (entry: QueuedSend) => {
        const result = await voxSend(
          entry.phone,
          entry.body,
          entry.from ? { fromOverride: entry.from, fallbackPrefix: entry.fallbackPrefix } : undefined,
        );
        await logSms({
          ts: new Date().toISOString(),
          phone: entry.phone,
          source: entry.source,
          status: result.status,
          ok: result.ok,
          error: result.ok ? undefined : `[admin-drain] ${result.error || "unknown"}`,
          body: entry.body,
          sessionIds: entry.audit?.sessionIds,
          personIds: entry.audit?.personIds,
          memberCount: entry.audit?.memberCount,
          shortCode: entry.shortCode,
          provider: result.provider,
          failedOver: result.failedOver,
        });
        // Mirror the sweep cron's video-match patch path so the videos
        // board flips chips green immediately on admin-triggered drain.
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
            console.warn("[admin/sms-quota drain] video-match patch failed:", err);
          }
        }
        return { ok: result.ok, status: result.status, error: result.error };
      });
    }

    if (!cleared && !drainResult) {
      return NextResponse.json(
        { error: "action required: 'clear' | 'drain' | 'clear-and-drain'" },
        { status: 400 },
      );
    }

    return NextResponse.json({
      ok: true,
      cleared,
      drain: drainResult,
      queueAfter: await quotaQueueSize(),
    });
  } catch (err) {
    console.error("[admin/sms-quota POST]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed" },
      { status: 500 },
    );
  }
}
