import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { processVideoEvent, videoEventFromWebhookPayload } from "@/lib/video-event-processor";
import { stampCameraSeen } from "@/lib/camera-assign";
import {
  bufferPendingMatch,
  drainDuePendingMatches,
  orderedMatchingEnabled,
} from "@/lib/video-pending-match";

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
  const innerType = typeof payload.eventType === "string" ? payload.eventType : "video-updated";
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
      innerType === "sample-uploaded" && typeof payload.url === "string" ? payload.url : undefined,
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
    // (it has limited buffer). The shadow consumer + cron will catch
    // the video on their own polling passes.
  }

  // Bridge heartbeat — cron at /api/cron/video-match reads this to
  // decide whether to skip its 500-record poll. As long as the
  // webhook saw an event in the last 10 min, the bridge is alive and
  // the cron exits early. If this key goes stale, cron kicks in as a
  // self-healing backstop. Best-effort — Redis hiccups don't block
  // the response.
  redis.set("vt3:bridge:last-event", new Date().toISOString(), "EX", 3600).catch(() => void 0);

  /**
   * THE CAMERA IS BACK IN THE BUILDING — recorded here, for the briefing-room
   * return strip (features/signage/briefing/camera-return.ts).
   *
   * VT3 only knows about a clip once the camera has reached a base station, so
   * the mere existence of this event is the physical fact we want. `createdAt`
   * is that registration moment; it beats the readiness gate below by minutes
   * (owner 2026-08-12: "we're watching for the registered time…not waiting for
   * the video to finish upload" — measured at +2 min median after the flag).
   *
   * SO THIS IS DELIBERATELY UNGATED: every event, any `status`, any
   * `innerType`, `sampleUploadTime` null or not. Gating it on readiness would
   * be borrowing a guest-notification rule to answer an inventory question and
   * would leave a returned camera red on the wall for an hour.
   *
   * BOTH KEYS, because the scanned number lands in `video.camera` for some
   * records and `system.name` for others — the same two-key ambiguity
   * `matchVideoEvent` already has to live with. Stamping both means a sighting
   * is never missed; the cost of stamping a dock/base-station id that is not a
   * camera number is a `camera-seen:913` key nothing ever reads.
   */
  {
    const seenAtMs = typeof payload.createdAt === "string" ? Date.parse(payload.createdAt) : NaN;
    // No parseable registration time — fall back to now. We know the camera is
    // back; only the precise moment is in doubt.
    const at = Number.isFinite(seenAtMs) ? seenAtMs : Date.now();
    if (typeof payload.camera === "number") void stampCameraSeen(String(payload.camera), at);
    if (system?.name && String(system.name) !== String(payload.camera)) {
      void stampCameraSeen(String(system.name), at);
    }
  }

  // ── Live processing path ──
  // PATH-1 work (existing match: overlay refresh, block sync,
  // deferred notify) runs inline — it's order-insensitive and
  // latency-critical. NEW-match creation is order-SENSITIVE (the
  // matcher assigns identity by position, so arrival order decides
  // who gets which video — see lib/video-pending-match.ts), so with
  // ordered matching on (default), first sightings are buffered and
  // processed oldest-created_at-first by the drain below after a
  // settle window. VIDEO_MATCH_ORDERED=false reverts to the old
  // inline behavior.
  //
  // Best-effort: a processor failure logs but doesn't fail the
  // webhook (the cron is the safety net).
  let processedDecision: string | undefined;
  const ordered = orderedMatchingEnabled();
  try {
    const eventInput = videoEventFromWebhookPayload(payload, innerType);
    const result = await processVideoEvent(eventInput, {
      source: "webhook",
      skipCreate: ordered,
    });
    processedDecision = result.decision;
    if (ordered && result.decision === "skip-buffered") {
      await bufferPendingMatch(eventInput);
    }
    console.log(
      `[vt3-webhook] code=${videoCode} inner=${innerType} → decision=${result.decision}` +
        (result.notifyFired
          ? ` smsOk=${result.notifySmsOk ?? "-"} emailOk=${result.notifyEmailOk ?? "-"}`
          : ""),
    );
  } catch (err) {
    console.error(`[vt3-webhook] processVideoEvent threw for code=${videoCode}:`, err);
  }

  // Opportunistic ordered drain — processes any buffered first
  // sightings that have settled. Cheap when nothing is due, and the
  // NX drain lock makes concurrent webhook invocations no-ops. The
  // video-match cron also drains every tick as the quiet-tail
  // backstop (last events of the night have no later webhook call
  // to piggyback on).
  if (ordered) {
    try {
      const drained = await drainDuePendingMatches({ source: "webhook" });
      if (drained.drained > 0) {
        console.log(
          `[vt3-webhook] ordered drain processed ${drained.drained} (held ${drained.held}):`,
          drained.decisions,
        );
      }
    } catch (err) {
      console.error("[vt3-webhook] ordered drain failed:", err);
    }
  }

  return NextResponse.json({
    ok: true,
    kind: "queued",
    videoCode,
    innerType,
    decision: processedDecision,
  });
}
