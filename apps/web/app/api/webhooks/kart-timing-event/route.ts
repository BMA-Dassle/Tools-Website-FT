import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import redis from "@/lib/redis";
import { handleVenueMessage } from "~/features/signage/briefing/race-finish.server";
import { updateRaceClocks } from "~/features/racing/race-clock.server";
import { handleTrackEvents } from "~/features/racing/track-events.server";

/**
 * Kart timing broadcast webhook — receives messages forwarded by
 * the kart-timing-bridge worker (Railway).
 *
 * The bridge holds a WebSocket connection to the FastTrax kart
 * timing server, sends the BcStart subscription, and POSTs every
 * inbound broadcast message here.
 *
 * Phase 1 (this commit): receive, gate-check, push into a Redis
 * FIFO `kart:events:queue` (capped 5000, 24h TTL) for inspection.
 * Same pattern as the VT3 webhook — see what flows through
 * before deciding what to act on.
 *
 * Trust gate: `x-kart-bridge-secret` header MUST equal either
 * KART_BRIDGE_SECRET or VT3_BRIDGE_SECRET env. Sharing one secret
 * between vt3-bridge and kart-timing-bridge is fine — keeps env
 * config minimal. Deploy can override either name.
 */

const KART_SECRET = process.env.KART_BRIDGE_SECRET || "";
const VT3_SECRET = process.env.VT3_BRIDGE_SECRET || "";
const QUEUE_KEY = "kart:events:queue";
const QUEUE_MAX_LEN = 5000;
const QUEUE_TTL = 60 * 60 * 24; // 24h
const HEARTBEAT_KEY = "kart:bridge:last-event";
const HEARTBEAT_TTL = 60 * 60; // 1h

interface IncomingPayload {
  receivedAt?: string;
  message?: unknown;
}

function secretValid(provided: string | null): boolean {
  if (!provided) return false;
  // Accept either secret — supports the "one secret for both bridges"
  // setup or distinct secrets per bridge if we ever rotate them.
  if (KART_SECRET && provided === KART_SECRET) return true;
  if (VT3_SECRET && provided === VT3_SECRET) return true;
  return false;
}

export async function POST(req: NextRequest) {
  if (!KART_SECRET && !VT3_SECRET) {
    console.error(
      "[kart-webhook] no secret configured (set KART_BRIDGE_SECRET or VT3_BRIDGE_SECRET)",
    );
    return NextResponse.json({ error: "server not configured" }, { status: 500 });
  }
  const provided = req.headers.get("x-kart-bridge-secret");
  if (!secretValid(provided)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: IncomingPayload;
  try {
    body = (await req.json()) as IncomingPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Discriminate by $type if the message is a structured object.
  // SMS-Timing protocol uses .NET-style $type discrimination
  // (BcRaceState, BcInfo, BcTiming, etc.).
  const message = body.message;
  let messageType = "raw";
  if (typeof message === "object" && message !== null && "$type" in message) {
    const t = (message as Record<string, unknown>).$type;
    if (typeof t === "string") messageType = t;
  }

  // Stash compact entry in the FIFO. Bridge already snapshotted
  // receivedAt for us; we add an ingestedAt server-side timestamp
  // so latency comparisons are possible.
  const entry = JSON.stringify({
    messageType,
    bridgeReceivedAt: body.receivedAt ?? null,
    ingestedAt: new Date().toISOString(),
    message,
  });
  try {
    await redis.lpush(QUEUE_KEY, entry);
    await redis.ltrim(QUEUE_KEY, 0, QUEUE_MAX_LEN - 1);
    await redis.expire(QUEUE_KEY, QUEUE_TTL);
  } catch (err) {
    console.error("[kart-webhook] redis enqueue failed:", err);
    // Still return 200 — we don't want the bridge buffering forever.
  }

  // Heartbeat — useful for "is the kart bridge alive?" admin checks
  // and any future heartbeat-gated cron, mirroring the VT3 pattern.
  redis.set(HEARTBEAT_KEY, new Date().toISOString(), "EX", HEARTBEAT_TTL).catch(() => void 0);

  /**
   * THE BRIDGE'S ARRIVAL STAMP — resolved once, ahead of both handlers below,
   * because both now need it and they must not disagree about when a message
   * landed. `Date.now()` here is that moment plus the POST, the bridge's serial
   * queue and Vercel's scheduling; the wall showed the difference as a countdown
   * ~3s slow (owner 2026-08-15). Falls back to our clock only if the stamp is
   * missing or unparseable.
   */
  const bridgeStampMs = body.receivedAt ? Date.parse(body.receivedAt) : NaN;
  const anchorMs = Number.isFinite(bridgeStampMs) ? bridgeStampMs : Date.now();

  // Phase 2: act on the race lifecycle. A fresh RaceFinish in this message
  // flips the welcome-back fast path, captures final standings off the timing
  // socket, and fires the return radio call — seconds after the flag instead
  // of Pandora's ~40s stamp lag plus our polling. Runs via after() (the
  // terminal-checkout pattern) so the bridge gets its 200 immediately: the
  // bridge forwards sequentially, and holding this response through a capture
  // plus a radio POST would delay every message queued behind it — worsening
  // the very latency the fast path exists to fix (review 2026-08-12). The
  // handler never throws; a failure inside after() costs one race the fast
  // path, and the Pandora fallback still covers it.
  after(() => handleVenueMessage(message, anchorMs));

  /**
   * The race countdown every TV in the building reads.
   *
   * Folds RaceStart / RaceStop / RaceFinish / SessionDurationChangedNotification
   * into per-race clock state in Redis. Separate from handleVenueMessage on
   * purpose: that one fires irreversible live effects (radio calls, standings
   * captures) behind freshness gates, while this is pure bookkeeping that must
   * run for EVERY message including replayed ones — a catch-up dump after a
   * bridge restart is exactly how a clock recovers its state.
   *
   * Ordering is guaranteed by the bridge POSTing serially, which is also what
   * makes the read-modify-write in here safe without a lock.
   *
   * ANCHORED TO THE BRIDGE'S ARRIVAL STAMP, NOT OUR OWN CLOCK. The green flag's
   * anchor is the moment the frame landed at the bridge; `Date.now()` here is
   * that plus the POST, the serial queue and Vercel's own scheduling, and the
   * wall showed it — a countdown ~3s slow (owner 2026-08-15). Falls back to our
   * clock only if the stamp is missing or unparseable, since a clock a few
   * seconds out still beats no clock — see the anchor resolved above.
   */
  after(() => updateRaceClocks(message, anchorMs));

  /**
   * THE TRACK INCIDENT LOG — emergency stops, session starts and finishes, and
   * desk pauses, into Neon and onto the track's cameras.
   *
   * Third and separate from the two above because it writes a SAFETY RECORD
   * rather than a live effect or clock state. It takes no anchor: every event it
   * handles carries the VENUE's own stamp, which is the whole reason it can be
   * honest about a 76-second incident that a once-a-minute sampler could only
   * smear. Never throws — see track-events.server.ts.
   */
  after(() => handleTrackEvents(message));

  console.log(`[kart-webhook] queued type=${messageType}`);
  return NextResponse.json({ ok: true, kind: "queued", messageType });
}
