import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import type { SmsLogEntry } from "@/lib/sms-log";
import type { VideoMatch } from "@/lib/video-match";

/**
 * Voxtelesys delivery-status webhook receiver.
 *
 * Vox POSTs here every time a message changes state — `queued` →
 * `sent` → `delivered` / `undelivered` / `failed`. Wired via the
 * `status_callback: { url, method }` parameter on every send (see
 * `lib/sms-retry.ts` voxSendOnce).
 *
 * Why we need this: Vox's send response only tells us they ACCEPTED
 * the message (HTTP 200). Whether the carrier actually delivered to
 * the handset is reported separately via this webhook. Without it
 * the SMS log just says "ok 200" forever — we'd never see things
 * like "carrier rejected message too long" (error code 4505) which
 * is exactly what was happening to long e-ticket bodies on Mega day.
 *
 * Payload shape (observed):
 *   {
 *     id: string,                        // Vox message id (matches what
 *                                        // voxSend captured at send time)
 *     to: string, from: string,
 *     status: "queued" | "sent" | "delivered" | "undelivered" | "failed",
 *     time: ISO,
 *     direction: "outbound",
 *     error: { code?: number, description?: string },  // {} on success
 *     segments?: number,
 *     // ...other Vox fields we don't read
 *   }
 *
 * We update the matching SMS log entry in place so the admin SMS log
 * can show actual delivery state alongside the original send.
 *
 * Retry-on-failure: returning non-2xx makes Vox retry the callback up
 * to ~5 times. We always return 200 once we've parsed a body — even
 * when we can't find the matching log entry — so Vox's queue doesn't
 * back up. Lost matches are logged so we can debug.
 */

interface VoxStatusPayload {
  /** Older Vox API versions used `id`. The 2025-02-01 webhook
   *  payload uses `message_id`. We accept both — message_id wins
   *  when present. */
  id?: string;
  message_id?: string;
  status?: "queued" | "sent" | "delivered" | "undelivered" | "failed";
  time?: string;
  direction?: string;
  to?: string;
  from?: string;
  error?: { code?: number; description?: string };
  segments?: number;
  channel?: string;
  type?: string;
  api_version?: string;
}

/** Index used by the webhook to find the SMS log day-key + position
 *  for a given Vox message id. Set at send time inside logSms when
 *  providerMessageId is present, expires alongside the log itself. */
function indexKey(voxId: string): string {
  return `sms:log:idx:vox:${voxId}`;
}

const INDEX_TTL = 60 * 60 * 24 * 90; // 90 days, matches sms-log TTL

/** Public so logSms can call it at write time. */
export async function recordVoxIndex(voxId: string, dayKey: string): Promise<void> {
  try {
    await redis.set(indexKey(voxId), dayKey, "EX", INDEX_TTL);
  } catch (err) {
    console.warn("[sms-webhook/vox] index write failed:", err);
  }
}

export async function POST(req: NextRequest) {
  // Hit counter — proves Vox is actually calling us. Increment
  // before any parsing so even malformed-payload calls are counted.
  // Inspect via /api/sms-webhook/vox?stats=1 (GET, see below).
  try {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const tx = redis.multi();
    tx.incr(`sms-webhook:vox:hits:${today}`);
    tx.expire(`sms-webhook:vox:hits:${today}`, 60 * 60 * 24 * 30);
    tx.set(`sms-webhook:vox:lastHit`, new Date().toISOString(), "EX", 60 * 60 * 24 * 30);
    await tx.exec();
  } catch { /* ignore — counter is best-effort */ }

  let payload: VoxStatusPayload;
  let rawBody = "";
  try {
    rawBody = await req.text();
    payload = JSON.parse(rawBody) as VoxStatusPayload;
  } catch (err) {
    console.warn("[sms-webhook/vox] non-JSON callback body:", err, "raw:", rawBody.slice(0, 500));
    // Stash the most recent malformed payload for debugging without
    // needing Vercel function logs. Trim to 1KB to be safe.
    try {
      await redis.set("sms-webhook:vox:lastBadPayload", rawBody.slice(0, 1024), "EX", 60 * 60 * 24 * 7);
    } catch { /* ignore */ }
    // 200 anyway — we don't want Vox retrying a permanently-bad shape.
    return NextResponse.json({ ok: false, error: "invalid json" });
  }
  // Stash the most recent VALID payload for debugging — lets us see
  // the actual shape Vox sends without Vercel logs.
  try {
    await redis.set("sms-webhook:vox:lastPayload", rawBody.slice(0, 1024), "EX", 60 * 60 * 24 * 7);
  } catch { /* ignore */ }

  // Vox API 2025-02-01 sends `message_id`; older shapes used `id`.
  // Accept both — message_id takes precedence since that's the
  // current production payload shape (verified via the lastPayload
  // stat snapshot during webhook bring-up).
  const voxId = payload?.message_id || payload?.id;
  const status = payload?.status;
  if (!voxId || !status) {
    console.warn("[sms-webhook/vox] missing message_id/status:", JSON.stringify(payload).slice(0, 300));
    return NextResponse.json({ ok: false, error: "missing message_id or status" });
  }

  // Resolve the day-key index so we know which sms:log:{date} list
  // holds the original send entry. Without the index we'd have to
  // scan every day's log to find the matching providerMessageId.
  const dayKey = await redis.get(indexKey(voxId));
  if (!dayKey) {
    console.warn(`[sms-webhook/vox] no log entry for vox id ${voxId} (status=${status}) — older than 90d or never indexed`);
    return NextResponse.json({ ok: true, indexed: false });
  }

  // Update the matching SMS log entry in place. We pull the whole
  // list, find the entry by providerMessageId, mutate, and write
  // back. Lists in Redis are not random-access, so this is the
  // simplest correct approach. The 10k cap on per-day entries keeps
  // this O(N≤10k) which is fine for a webhook hot path.
  try {
    const raw = await redis.lrange(dayKey, 0, -1);
    let updated = false;
    const next = raw.map((s) => {
      try {
        const entry = JSON.parse(s) as SmsLogEntry;
        if (entry.providerMessageId === voxId) {
          entry.deliveryStatus = status;
          entry.deliveryUpdatedAt = payload.time || new Date().toISOString();
          if (payload.error?.code) {
            entry.deliveryErrorCode = String(payload.error.code);
          }
          if (payload.error?.description) {
            // Append the carrier reason to the existing error field
            // so the admin UI can show e.g. "code 4505: carrier
            // rejected message too long" without a second column.
            const desc = `Vox ${status} (${payload.error.code}: ${payload.error.description})`;
            entry.error = entry.error ? `${entry.error} | ${desc}` : desc;
          }
          updated = true;
          return JSON.stringify(entry);
        }
        return s;
      } catch {
        return s;
      }
    });
    if (updated) {
      // Replace the whole list atomically. del + rpush keeps order
      // (newest-first via LPUSH at write time). We push in reverse
      // so the resulting list reads same as before.
      const tx = redis.multi();
      tx.del(dayKey);
      if (next.length > 0) tx.rpush(dayKey, ...next);
      tx.expire(dayKey, 60 * 60 * 24 * 90);
      await tx.exec();
    } else {
      console.warn(`[sms-webhook/vox] index pointed to ${dayKey} but no matching entry for ${voxId}`);
    }
  } catch (err) {
    console.error("[sms-webhook/vox] log update failed:", err);
    // Don't 500 — Vox would retry. Better to let this one slip than
    // have stuck callbacks pile up in their queue.
  }

  // ── Mirror the delivery state onto a matching VIDEO record ────
  // The video-notify path writes a `video:msgid:{voxId}` index when
  // it sends — if present, find the video-match record by its
  // videoCode and patch the delivery fields in place. Lets the
  // videos admin show GREEN "delivered ✓" on actual carrier-DLR-
  // confirmed receipts, not just YELLOW "sent ⋯" forever.
  await updateVideoRecordIfPresent(voxId, payload);

  return NextResponse.json({ ok: true, status });
}

/** Look up the video match associated with this Vox messageId and
 *  patch the carrier DLR fields. No-op when there's no
 *  `video:msgid:*` index entry (i.e. the SMS wasn't a video-notify).
 *
 *  Note: this scans `video-match:*:*` keys via the videoCode-keyed
 *  sentinel — each sentinel stores `{sessionId, personId}` so we can
 *  reconstruct the primary record key without an extra lookup. */
async function updateVideoRecordIfPresent(
  voxId: string,
  payload: VoxStatusPayload,
): Promise<void> {
  try {
    const videoCode = await redis.get(`video:msgid:${voxId}`);
    if (!videoCode) return;
    const sentinelRaw = await redis.get(`video-match:by-code:${videoCode}`);
    if (!sentinelRaw) return;
    const sentinel = JSON.parse(sentinelRaw) as { sessionId?: string | number; personId?: string | number };
    if (!sentinel.sessionId || !sentinel.personId) return;
    const recordKey = `video-match:${sentinel.sessionId}:${sentinel.personId}`;
    const recordRaw = await redis.get(recordKey);
    if (!recordRaw) return;
    const record = JSON.parse(recordRaw) as VideoMatch;
    record.notifySmsDeliveryStatus = payload.status;
    record.notifySmsDeliveryUpdatedAt = payload.time || new Date().toISOString();
    if (payload.error?.code) {
      record.notifySmsDeliveryErrorCode = String(payload.error.code);
    }
    // Preserve the existing TTL by reading PTTL first; fallback to
    // the standard 90-day window if Redis has no TTL on the key.
    const pttl = await redis.pttl(recordKey);
    const ttlSeconds = pttl > 0 ? Math.ceil(pttl / 1000) : 60 * 60 * 24 * 90;
    await redis.set(recordKey, JSON.stringify(record), "EX", ttlSeconds);
  } catch (err) {
    console.warn(`[sms-webhook/vox] video record patch failed for ${voxId}:`, err);
  }
}

/** GET returns a 200 ack for Vox's endpoint validation, OR — when
 *  hit with `?stats=1` — exposes the hit counter + last-payload
 *  snapshots so we can verify Vox is actually calling us in
 *  production without needing Vercel function logs. */
export async function GET(req: NextRequest) {
  const wantsStats = new URL(req.url).searchParams.get("stats") === "1";
  if (!wantsStats) {
    return NextResponse.json({ ok: true, hint: "POST your status callbacks here" });
  }
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  try {
    const [hitsToday, lastHit, lastPayload, lastBad] = await Promise.all([
      redis.get(`sms-webhook:vox:hits:${today}`),
      redis.get(`sms-webhook:vox:lastHit`),
      redis.get(`sms-webhook:vox:lastPayload`),
      redis.get(`sms-webhook:vox:lastBadPayload`),
    ]);
    return NextResponse.json({
      ok: true,
      hitsToday: hitsToday ? parseInt(hitsToday, 10) : 0,
      lastHit: lastHit || null,
      lastPayloadSample: lastPayload ? safeJsonOrString(lastPayload) : null,
      lastBadPayloadSample: lastBad || null,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "stats read failed" });
  }
}

function safeJsonOrString(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
