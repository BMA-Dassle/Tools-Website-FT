import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

/**
 * VT3 video event webhook — receives push events forwarded by the
 * vt3-bridge worker (Railway/Fly).
 *
 * Confirmed schema from PROBE-mode logs (2026-05-03):
 *   {
 *     eventType: "connected" | "message",  // SSE event name
 *     eventId:   string | null,             // VT3 doesn't use SSE IDs
 *     data:      {
 *       // For SSE event=message:
 *       id:        number,                   // VT3 video pk
 *       code:      string,                   // 10-char share code
 *       site:      { id, uid, name },
 *       system:    { id, username, name },   // kart number on `name`
 *       status:    "TRANSFERRED" | "FOR_SAMPLING" | "SAMPLING" | "FOR_ENCODING" | "IS_ENCODING" | "PENDING_ACTIVATION" | "READY" | ...,
 *       sampleUploadTime: string | null,
 *       updatedAt: string, createdAt: string,
 *       camera:    number,
 *       eventType: "video-updated" | "sample-uploaded",  // INNER discriminator
 *       url?:      string,                   // present on sample-uploaded
 *       ...
 *     } | string                             // for connected events: bare UUID
 *   }
 *
 * Phase 1 (this commit): receive, gate-check, push into a Redis
 * FIFO queue (`vt3:events:queue`). The existing video-match cron
 * drains that queue at the start of each tick BEFORE its own
 * VT3 listRecentVideos poll, giving us fast-path coverage for events
 * that land between cron ticks. Polling continues as the workhorse +
 * backstop.
 *
 * Phase 2 (future): move the per-video match logic out of the cron
 * route into a reusable helper, call it directly here, drop the
 * polling cron entirely.
 *
 * Trust gate: `x-vt3-bridge-secret` header MUST equal
 * VT3_BRIDGE_SECRET env. Anything else gets a 403.
 */

const SHARED_SECRET = process.env.VT3_BRIDGE_SECRET || "";
const SITE_FILTER = parseInt(process.env.VT3_SITE_ID || "992", 10); // FastTrax = 992
const QUEUE_KEY = "vt3:events:queue";
const QUEUE_MAX_LEN = 5000; // backstop against unbounded growth if cron stalls
const QUEUE_TTL = 60 * 60 * 24; // 24h — cron drains every 2 min, well within

interface IncomingEvent {
  eventType?: string;
  eventId?: string | null;
  data?: unknown;
}

export async function POST(req: NextRequest) {
  // Trust gate.
  if (!SHARED_SECRET) {
    console.error("[vt3-webhook] VT3_BRIDGE_SECRET not configured");
    return NextResponse.json({ error: "server not configured" }, { status: 500 });
  }
  const provided = req.headers.get("x-vt3-bridge-secret");
  if (provided !== SHARED_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: IncomingEvent;
  try {
    body = (await req.json()) as IncomingEvent;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const eventType = typeof body.eventType === "string" ? body.eventType : "";
  const data = body.data;

  // `connected` events carry the session UUID — bridge worker uses
  // them for ACK; we just acknowledge receipt and move on. No queue
  // write needed (no video data to process).
  if (eventType === "connected") {
    console.log(
      `[vt3-webhook] connected sessionId=${typeof data === "string" ? data : "(unknown)"}`,
    );
    return NextResponse.json({ ok: true, kind: "connected" });
  }

  // `message` events carry the actual video lifecycle updates.
  // Discriminate on the INNER `data.eventType` (PROBE logs showed
  // this is where VT3 puts the real event name: "video-updated" or
  // "sample-uploaded").
  if (eventType !== "message" || typeof data !== "object" || data === null) {
    console.log(`[vt3-webhook] ignoring non-message event=${eventType}`);
    return NextResponse.json({ ok: true, kind: "ignored", reason: "not-message" });
  }
  const payload = data as Record<string, unknown>;
  const innerType =
    typeof payload.eventType === "string" ? payload.eventType : "video-updated";
  const videoCode = typeof payload.code === "string" ? payload.code : "";
  const videoId = typeof payload.id === "number" ? payload.id : null;
  const status = typeof payload.status === "string" ? payload.status : null;

  // Filter to FastTrax site only. VT3 may emit events for sites
  // we don't care about (Lehigh, future locations) — drop early.
  const site = payload.site as { id?: number } | undefined;
  if (site?.id && site.id !== SITE_FILTER) {
    return NextResponse.json({ ok: true, kind: "ignored", reason: "wrong-site" });
  }

  // Refuse events without a video code — nothing to match against.
  if (!videoCode) {
    return NextResponse.json({ ok: true, kind: "ignored", reason: "no-code" });
  }

  // Push into the FIFO queue. Capped via LTRIM so a runaway VT3
  // (or a stalled consumer) can't bloat Redis. The shadow consumer
  // at /api/cron/vt3-shadow-consumer drains this and logs decisions
  // to Neon for evaluation; once promoted to live, the same payload
  // shape drives the real reactor.
  //
  // We snapshot the fields the decision tree needs so consumers
  // never have to re-fetch from VT3:
  //   - systemName + createdAt → camera-assignment lookup key
  //   - sampleUploadTime → readiness gate
  //   - cameraNumber → admin UI overlays
  const system = payload.system as { name?: string; id?: number } | undefined;
  const entry = JSON.stringify({
    videoCode,
    videoId,
    innerType,
    status,
    sampleUrl:
      innerType === "sample-uploaded" && typeof payload.url === "string"
        ? payload.url
        : undefined,
    systemName: system?.name,
    createdAt: typeof payload.createdAt === "string" ? payload.createdAt : undefined,
    sampleUploadTime:
      typeof payload.sampleUploadTime === "string" ? payload.sampleUploadTime : null,
    cameraNumber: typeof payload.camera === "number" ? payload.camera : undefined,
    receivedAt: new Date().toISOString(),
  });
  try {
    await redis.lpush(QUEUE_KEY, entry);
    await redis.ltrim(QUEUE_KEY, 0, QUEUE_MAX_LEN - 1);
    await redis.expire(QUEUE_KEY, QUEUE_TTL);
  } catch (err) {
    console.error("[vt3-webhook] redis enqueue failed:", err);
    // Still return 200 — we don't want the bridge to keep retrying
    // (it has limited buffer). The cron will catch the video on its
    // own next polling pass.
  }

  console.log(
    `[vt3-webhook] queued code=${videoCode} inner=${innerType} status=${status ?? "-"}`,
  );
  return NextResponse.json({
    ok: true,
    kind: "queued",
    videoCode,
    innerType,
  });
}
