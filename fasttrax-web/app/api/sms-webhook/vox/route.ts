import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import type { SmsLogEntry } from "@/lib/sms-log";

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
  id?: string;
  status?: "queued" | "sent" | "delivered" | "undelivered" | "failed";
  time?: string;
  direction?: string;
  to?: string;
  from?: string;
  error?: { code?: number; description?: string };
  segments?: number;
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
  let payload: VoxStatusPayload;
  try {
    payload = (await req.json()) as VoxStatusPayload;
  } catch (err) {
    console.warn("[sms-webhook/vox] non-JSON callback body:", err);
    // 200 anyway — we don't want Vox retrying a permanently-bad shape.
    return NextResponse.json({ ok: false, error: "invalid json" });
  }

  const voxId = payload?.id;
  const status = payload?.status;
  if (!voxId || !status) {
    console.warn("[sms-webhook/vox] missing id/status:", JSON.stringify(payload).slice(0, 300));
    return NextResponse.json({ ok: false, error: "missing id or status" });
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

  return NextResponse.json({ ok: true, status });
}

/** Vox may also send GET to verify the endpoint exists when first
 *  configured. Respond 200 so the validation passes. */
export async function GET() {
  return NextResponse.json({ ok: true, hint: "POST your status callbacks here" });
}
