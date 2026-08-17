import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

/**
 * Kart bridge lifecycle log — boots and dead sockets, nothing else.
 *
 * WHY THIS EXISTS. The bridge's reconnects only ever went to Railway stdout, so
 * "did it have to recover, or did we restart it?" was not answerable from
 * anywhere we can query. On 2026-08-16 answering it took a morning: five session
 * breaks reconstructed by matching full-snapshot replays in `kart:events:queue`
 * against commit timestamps, and one candidate event at 07:01:47 pinned as
 * venue-side only by measuring the phase drift of the undeduped BcTime ticker.
 * All of that is two fields — `bootId` and `reconnects` — written here.
 *
 * Deliberately SEPARATE from /api/webhooks/kart-timing-event. That route's
 * payloads are folded into the race clock and the finish fast path; a synthetic
 * lifecycle record travelling that rail would be one more shape those consumers
 * have to ignore correctly, forever. This one only writes.
 *
 * Retention is generous on purpose: `kart:events:queue` holds ~45 min during
 * racing, which is why the evidence for the original outage was already evicted
 * by the time anyone looked. 400 sessions at the observed rate is months.
 */

const KART_SECRET = process.env.KART_BRIDGE_SECRET || "";
const VT3_SECRET = process.env.VT3_BRIDGE_SECRET || "";
const LAST_KEY = "kart:bridge:last-session";
const LOG_KEY = "kart:bridge:sessions";
const LOG_MAX_LEN = 400;
const LOG_TTL = 60 * 60 * 24 * 30; // 30d

interface SessionPayload {
  event?: string;
  bootId?: string;
  reconnects?: number;
  at?: string;
  frames?: number;
  openMs?: number;
  healthy?: boolean;
  reason?: string;
  nextDelayMs?: number;
}

function secretValid(provided: string | null): boolean {
  if (!provided) return false;
  // Same either-secret gate as the event webhook — one shared secret across
  // both bridges is the deployed reality; see that route for the rationale.
  if (KART_SECRET && provided === KART_SECRET) return true;
  if (VT3_SECRET && provided === VT3_SECRET) return true;
  return false;
}

export async function POST(req: NextRequest) {
  if (!KART_SECRET && !VT3_SECRET) {
    console.error(
      "[kart-session] no secret configured (set KART_BRIDGE_SECRET or VT3_BRIDGE_SECRET)",
    );
    return NextResponse.json({ error: "server not configured" }, { status: 500 });
  }
  if (!secretValid(req.headers.get("x-kart-bridge-secret"))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: SessionPayload;
  try {
    body = (await req.json()) as SessionPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const entry = {
    event: body.event === "boot" ? "boot" : "session-end",
    bootId: typeof body.bootId === "string" ? body.bootId : "?",
    reconnects: Number.isFinite(body.reconnects) ? Number(body.reconnects) : null,
    // The bridge's own stamp is the truth about WHEN the socket died; ours is
    // only when we heard about it. Keep both — the gap between them is itself a
    // signal, and a bridge that cannot reach us at all leaves neither.
    bridgeAt: typeof body.at === "string" ? body.at : null,
    receivedAt: new Date().toISOString(),
    frames: Number.isFinite(body.frames) ? Number(body.frames) : null,
    openMs: Number.isFinite(body.openMs) ? Number(body.openMs) : null,
    healthy: typeof body.healthy === "boolean" ? body.healthy : null,
    reason: typeof body.reason === "string" ? body.reason.slice(0, 300) : null,
    nextDelayMs: Number.isFinite(body.nextDelayMs) ? Number(body.nextDelayMs) : null,
  };

  try {
    await redis.lpush(LOG_KEY, JSON.stringify(entry));
    await redis.ltrim(LOG_KEY, 0, LOG_MAX_LEN - 1);
    await redis.expire(LOG_KEY, LOG_TTL);
    await redis.set(LAST_KEY, JSON.stringify(entry), "EX", LOG_TTL);
  } catch (err) {
    console.error("[kart-session] redis write failed:", err);
    // 200 anyway. The bridge does not retry this and must not start buffering
    // telemetry while it has a socket to rebuild.
  }

  console.log(
    `[kart-session] ${entry.event} boot=${entry.bootId} reconnect#${entry.reconnects} ` +
      `openMs=${entry.openMs} healthy=${entry.healthy} reason="${entry.reason}"`,
  );
  return NextResponse.json({ ok: true });
}
