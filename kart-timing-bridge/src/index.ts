/**
 * Kart timing → webhook WebSocket bridge.
 *
 * Holds an always-open WebSocket connection to the SMS-Timing /
 * tournament-manager broadcast endpoint at the FastTrax kart timing
 * server, sends the BcStart subscription on open, and forwards every
 * inbound message to our Vercel webhook with a shared-secret header.
 *
 * Mirrors the vt3-bridge pattern (sibling subproject) — Vercel
 * Lambdas can't hold a long-lived WebSocket, so this runs on
 * Railway / Fly free tier and bridges the always-on stream into our
 * normal webhook-driven request/response model.
 *
 * Required env vars (set via `railway variables set` or Fly secrets):
 *   WS_URL             ws://68.171.192.138:10001 (or override per env)
 *   WEBHOOK_URL        https://fasttraxent.com/api/webhooks/kart-timing-event
 *   WEBHOOK_SECRET     shared with fasttraxent.com's KART_BRIDGE_SECRET
 *
 * Optional:
 *   PROBE              "1"/"true" → log every parsed message to stdout AND
 *                      forward to webhook. Default behavior also forwards;
 *                      this just adds verbose stdout dumps for debugging.
 *                      `npm run probe` passes --probe instead, which needs
 *                      no shell-specific env syntax.
 *   LOG_LEVEL          "debug" → log raw frames + reconnect timing
 *   SESSION_WEBHOOK_URL  override for the lifecycle endpoint. Defaults to
 *                      /api/webhooks/kart-bridge-session on WEBHOOK_URL's host,
 *                      so there is nothing to set in the normal case.
 *
 * Reconnect: exponential backoff (1s → 5min cap) on ws errors / closes.
 * Subscription resend: BcStart fires on every successful open.
 *
 * WHY THERE ARE THREE WATCHDOGS AND NOT ONE (2026-08-15/16):
 * this bridge went silent during a live session and stayed silent until it was
 * rebooted by hand. Nothing was broken enough to notice: the socket sat in
 * `readyState OPEN`, the process was healthy, Railway's `restartPolicyType:
 * ON_FAILURE` never fired because the reconnect loop below never exits, and the
 * only watchdog we had covered CONNECTING and had already been cleared. A
 * half-open socket — venue PC rebooted, NAT or firewall dropping the flow —
 * looks EXACTLY like a quiet venue from in here.
 *
 * So liveness is now asked three different ways, because each catches something
 * the others cannot:
 *
 *   1. CONNECT   — 30s to reach `open`, or the attempt is stalled.  (existing)
 *   2. PING      — every 25s; a ping sent while the previous pong is still
 *                  outstanding means the peer is gone even though TCP has not
 *                  admitted it yet.
 *   3. IDLE DATA — 45s with no FRAME AT ALL. The subscription asks for a resend
 *                  every second (`RaceStatsResendInterval`), so silence this
 *                  long is death, not calm. This is the one that would have
 *                  caught the outage above.
 *
 * All three end the same way: `terminate()`, never `close()`. A graceful close
 * waits for a handshake reply from a peer that by definition is not answering,
 * which would hang precisely when we need out. `terminate()` destroys the socket
 * and fires `close`, and the reconnect loop takes it from there.
 *
 * Backoff resets only after a connection that actually WORKED (delivered a frame
 * and lasted past HEALTHY_SESSION_MS). Resetting on any clean close let a socket
 * that dies instantly retry ~1/sec forever.
 *
 * WHY `ws` AND NOT NODE'S BUILT-IN WebSocket (2026-08-15, the whole night):
 * the venue runs websocket-sharp/1.0 and negotiates `permessage-deflate;
 * client_no_context_takeover; server_no_context_takeover`. EVERY frame comes
 * over compressed with RSV1 set, and on BcFormat "0" a message arrives
 * fragmented across three frames (TEXT fin=0 + CONT + CONT fin=1). Node's
 * built-in WebSocket (undici) handed all of those back as ZERO-LENGTH
 * STRINGS. This file then discarded them with a comment calling them "empty
 * keep-alives (~1/sec)" — so the bridge threw away 100% of the live stream
 * for its entire life while looking healthy. The ~1/sec was never a
 * keep-alive; it is RaceStatsResendInterval doing exactly what it says.
 * Proven by reading the socket with node:net and inflating by hand.
 * If you ever swap the client again, verify against a RUNNING race that
 * frames arrive with a payload — an idle venue looks identical to this bug.
 */

import WebSocket from "ws";
import { createHash, randomUUID } from "node:crypto";

const WS_URL = process.env.WS_URL ?? "ws://68.171.192.138:10001";
const WEBHOOK_URL = required("WEBHOOK_URL");
const WEBHOOK_SECRET = required("WEBHOOK_SECRET");
/**
 * Where session lifecycle goes. DERIVED from WEBHOOK_URL rather than read from
 * its own env var on purpose: a new required variable is a mechanism with no
 * trigger — it works on the machine where someone remembered to set it and
 * silently reports nothing everywhere else. Same host, different path.
 */
const SESSION_URL =
  process.env.SESSION_WEBHOOK_URL ??
  new URL("/api/webhooks/kart-bridge-session", WEBHOOK_URL).toString();
/**
 * Identifies THIS PROCESS. The whole point of the session log is telling two
 * indistinguishable things apart:
 *
 *   new bootId          → the process was replaced (Railway deploy or crash)
 *   same bootId, n+1    → the socket dropped and the bridge healed itself
 *
 * On 2026-08-16 that distinction cost a morning of forensics — five session
 * breaks had to be tied back to commit timestamps, and one candidate event at
 * 07:01:47 could only be narrowed to "venue-side" by measuring the phase drift
 * of the BcTime ticker in Redis. Two fields here answer it outright.
 */
const BOOT_ID = randomUUID().slice(0, 8);
// PROBE arrives three ways, because the old strict `=== "1"` check
// silently ignored two of them: a Railway env var, a line in
// .env.local (nothing loaded that file until the npm scripts grew
// --env-file-if-exists), or `--probe` on the command line — the only
// form that behaves the same in PowerShell as it does in bash.
const PROBE_MODE =
  process.env.PROBE === "1" ||
  process.env.PROBE?.toLowerCase() === "true" ||
  process.argv.includes("--probe");
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

/** How long to wait for `open` before calling the attempt stalled. */
const CONNECT_TIMEOUT_MS = 30_000;
/** Ping cadence once open. Comfortably under any sane idle-connection reaper,
 *  and frequent enough that a dead peer is caught inside one IDLE window. */
const PING_INTERVAL_MS = 25_000;
/**
 * Silence — measured on RAW FRAMES, before the dedupe — that means the peer is
 * gone. `RaceStatsResendInterval: "00:00:01"` makes the server resend its
 * snapshot every second even when nothing is happening, so a venue that is
 * merely idle still talks constantly. 45s allows for a stall of ~44 missed
 * resends before we act, which is generous and still well inside one race.
 *
 * MUST be measured on frames rather than on FORWARDS: `changedOnly()` suppresses
 * unchanged snapshots, so a quiet hour legitimately produces almost no forwards.
 * Watching forwards would fire this constantly and prove nothing.
 */
const IDLE_FRAME_TIMEOUT_MS = 45_000;
/** How often the idle check runs. Cheap; the resolution just has to be well
 *  under IDLE_FRAME_TIMEOUT_MS. */
const IDLE_CHECK_INTERVAL_MS = 5_000;
/** A session has to last this long AND have delivered a frame before we treat
 *  it as healthy enough to reset the backoff. */
const HEALTHY_SESSION_MS = 60_000;

// SMS-Timing / Tournament Manager broadcast subscription. Sent on
// every successful WebSocket open. Matches the protocol the user
// captured from their kart timing client. `Timing: "false"` is a
// string (not boolean) intentionally — server uses .NET-style JSON.
const BC_START_MESSAGE = {
  $type: "BcStart",
  Timing: "false",
  Notifications: "true",
  // "Karting" is the resource CATEGORY (per BMA dev). Setting it to a
  // specific track name like "Red Track" works but filters out the
  // other karting tracks (e.g. "Blue Track"). Subscribing at the
  // category level gets us all karting traffic in one stream; we
  // filter per-track Vercel-side via ResourceName / ResourceId.
  // Confirmed against live: Red Track catch-up = 52 items,
  // Blue Track catch-up = 47 items, Karting catch-up = 109 items.
  Resource: "Karting",
  BcFormat: "0",
  // Full set of NotificationGroups exposed by the SMS-Timing /
  // tournament-manager admin UI. Subscribing to all of them gives
  // the bridge maximum visibility — we can always filter Vercel-side.
  // Confirmed against the live admin's group list.
  NotificationGroups: [
    "BROADCAST",
    "CLIENTACTIONS",
    "DEVICE",
    "MAINTENANCE",
    "PERSON",
    "PROJECT",
    "SESSION",
    "SUBSCRIPTION",
    "SYSTEM",
    "TESTING",
    "TIMING",
  ],
  RaceStatsResendInterval: "00:00:01",
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[kart-bridge] missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

function debug(...args: unknown[]): void {
  if (LOG_LEVEL === "debug") console.log("[kart-bridge:debug]", ...args);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Forward one parsed message to the Vercel webhook. One retry on
 * transient failure; persistent failures get logged + dropped (the
 * webhook keeps a 24h Redis FIFO so brief network blips don't hurt
 * us — events keep arriving and the next event flushes any
 * cached state).
 */
async function forward(message: unknown, arrivedAt: string): Promise<void> {
  if (PROBE_MODE) {
    console.log("[kart-bridge:PROBE]", JSON.stringify(message));
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-kart-bridge-secret": WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          // Stamped when the FRAME LANDED, not now. The webhook anchors the race
          // clock to this, and "now" here is after the serial forward queue plus
          // any retry — which showed up on the wall as a countdown ~3s slow
          // (owner 2026-08-15). Sub-second accuracy is free; spending it on our
          // own plumbing is not.
          receivedAt: arrivedAt,
          message,
        }),
      });
      if (res.ok) return;
      console.warn(
        `[kart-bridge] webhook ${res.status} attempt ${attempt + 1}: ${await res
          .text()
          .catch(() => "")}`,
      );
    } catch (err) {
      console.warn(`[kart-bridge] webhook threw attempt ${attempt + 1}:`, err);
    }
    if (attempt === 0) await sleep(1000);
  }
  console.error("[kart-bridge] webhook persistently failed; dropping message");
}

/** One entry in the bridge's own lifecycle log. */
interface SessionReport {
  /** "boot" once per process; "session-end" every time a socket dies. */
  event: "boot" | "session-end";
  bootId: string;
  /** 0 on boot, then 1, 2, 3… WITHIN this process. Resets when bootId changes. */
  reconnects: number;
  at: string;
  /** Absent on boot. */
  frames?: number;
  openMs?: number;
  healthy?: boolean;
  /** The watchdog that ended it, verbatim — "no frame in 45s", "no pong within
   *  25s", "error: …", or a plain remote close. THE field you read first. */
  reason?: string;
  /** How long until the next attempt, so flapping is legible without maths. */
  nextDelayMs?: number;
}

/**
 * Report a lifecycle event. Fire-and-forget, and deliberately unable to hurt
 * anything: any throw is swallowed, and the request is capped by a 5s abort so
 * a wedged webhook can never stall the reconnect loop it is describing. The
 * whole value here is being readable when the bridge is sick — so it must not
 * become a way for the bridge to get sick.
 */
async function reportSession(report: SessionReport): Promise<void> {
  try {
    const res = await fetch(SESSION_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-kart-bridge-secret": WEBHOOK_SECRET,
      },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) console.warn(`[kart-bridge] session report ${res.status}`);
  } catch (err) {
    // Logged at warn, never rethrown: losing a line of telemetry is a nuisance,
    // losing the reconnect loop is an outage.
    console.warn(
      `[kart-bridge] session report failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Forward STRICTLY IN ORDER, one POST at a time.
 *
 * This used to be a bare `forward(x).catch(...)` per frame — fire-and-forget,
 * so POSTs overlapped and could land out of order. That is fine for an
 * append-only event log and NOT fine for the race clock the webhook now
 * maintains: a `RaceStart` applied before the `RaceStop` it followed banks a
 * negative pause and the countdown on every TV in the building goes wrong.
 *
 * Serialising here also means the webhook's read-modify-write on a race's
 * clock state can never race itself, so no Redis lock is needed — the ordering
 * guarantee IS the mutual exclusion. One writer, in order (same rule we hold
 * for BMI entities).
 *
 * The chain never rejects: a failed forward is logged inside `forward` and the
 * queue continues, because dropping one message must not wedge the pipe.
 */
let forwardChain: Promise<void> = Promise.resolve();
let queueDepth = 0;

function enqueueForward(message: unknown, arrivedAt: string): void {
  queueDepth++;
  forwardChain = forwardChain
    .then(() => forward(message, arrivedAt))
    .catch((err) => console.error("[kart-bridge] forward threw:", err))
    .finally(() => {
      queueDepth--;
      // A depth that keeps climbing means the webhook is slower than the feed;
      // say so, because silence here would look exactly like a healthy bridge.
      if (queueDepth > 20) console.warn(`[kart-bridge] forward queue depth ${queueDepth}`);
    });
}

/**
 * Suppress repeats.
 *
 * On BcFormat "0" the server re-sends its ENTIRE snapshot every second —
 * 45+ records, ~18KB — whether or not anything changed. Forwarding that
 * verbatim is 18KB/s at the webhook and would churn the 5000-entry Redis
 * FIFO in ~83 minutes, evicting the day's real events. So we keep the last
 * seen shape of each record and forward only what actually moved.
 *
 * Keyed on ($type, RaceId) and compared by content hash rather than
 * RecordVersion: RaceAdvice does not reliably carry a RecordVersion, and a
 * hash is correct for every record type without having to know which.
 */
const lastSeen = new Map<string, string>();

function changedOnly(parsed: unknown): unknown | null {
  if (!Array.isArray(parsed)) return parsed; // single pushes always forward
  const fresh: unknown[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      fresh.push(item);
      continue;
    }
    const rec = item as Record<string, unknown>;
    const key = `${String(rec.$type ?? "raw")}:${String(rec.RaceId ?? "?")}`;
    const hash = createHash("sha1").update(JSON.stringify(rec)).digest("hex");
    if (lastSeen.get(key) === hash) continue;
    lastSeen.set(key, hash);
    fresh.push(item);
  }
  return fresh.length ? fresh : null;
}

/** What one connection did, so the reconnect loop can tell a working session
 *  from a socket that opened and died. */
interface SessionResult {
  /** RAW frames received, pre-dedupe. Zero means the socket never carried data,
   *  which is the difference between "quiet venue" and "never actually up". */
  frames: number;
  /** How long the socket was OPEN. 0 if `open` never fired. */
  openMs: number;
  /** Why it ended, for the log line. */
  reason: string;
}

/**
 * Open the WebSocket, send BcStart, and forward every inbound
 * message until the connection closes.
 *
 * Uses the `ws` package, NOT Node's built-in WebSocket — see the header
 * comment. `ws` inflates permessage-deflate and reassembles continuation
 * frames; the built-in silently produces empty strings for both.
 *
 * Holds the three liveness watchdogs described in the header. Every one of them
 * ends the session the same way — `terminate()` — and every exit path runs
 * `clearTimers()`, because a timer leaked per reconnect adds up quickly on a
 * socket that is flapping every 30 seconds.
 */
async function consumeStream(): Promise<SessionResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { perMessageDeflate: true });
    let closed = false;
    let frames = 0;
    let openedAtMs = 0;
    let lastFrameAtMs = 0;
    let awaitingPong = false;
    let endReason = "closed by peer";

    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let idleTimer: ReturnType<typeof setInterval> | null = null;

    const clearTimers = (): void => {
      if (connectTimer !== null) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (pingTimer !== null) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (idleTimer !== null) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
    };

    /**
     * End this session now. `terminate()`, never `close()`: every caller of this
     * has just concluded the peer is not answering, and a graceful close waits
     * for a reply from exactly that peer. Destroying the socket fires `close`,
     * which resolves the promise and lets the reconnect loop run.
     */
    const kill = (reason: string): void => {
      endReason = reason;
      console.warn(`[kart-bridge] ${reason} — terminating socket`);
      clearTimers();
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    };

    ws.on("open", () => {
      openedAtMs = Date.now();
      // Start the idle clock at open, not at socket creation — the first frame
      // legitimately takes a moment to arrive after BcStart.
      lastFrameAtMs = openedAtMs;
      if (connectTimer !== null) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      console.log(`[kart-bridge] WebSocket open: ${WS_URL}`);
      try {
        ws.send(JSON.stringify(BC_START_MESSAGE));
        console.log(
          `[kart-bridge] sent BcStart (resource=${BC_START_MESSAGE.Resource}, groups=${BC_START_MESSAGE.NotificationGroups.join(",")})`,
        );
      } catch (err) {
        console.error("[kart-bridge] failed to send BcStart:", err);
      }

      // WATCHDOG 2 — the peer is gone but TCP has not admitted it.
      pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (awaitingPong) {
          kill(`no pong within ${PING_INTERVAL_MS / 1000}s`);
          return;
        }
        awaitingPong = true;
        try {
          ws.ping();
        } catch (err) {
          kill(`ping threw (${err instanceof Error ? err.message : String(err)})`);
        }
      }, PING_INTERVAL_MS);

      // WATCHDOG 3 — the socket is open and answering pings, yet no DATA is
      // arriving. The one that catches a venue-side stall.
      idleTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const silentMs = Date.now() - lastFrameAtMs;
        if (silentMs > IDLE_FRAME_TIMEOUT_MS) {
          kill(`no frame in ${Math.round(silentMs / 1000)}s (feed resends every 1s)`);
        }
      }, IDLE_CHECK_INTERVAL_MS);
    });

    ws.on("pong", () => {
      awaitingPong = false;
    });

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      // FIRST LINE OF THE HANDLER, deliberately — this timestamp becomes the
      // race clock's green-flag anchor downstream, so it must predate our own
      // parsing, dedupe and queueing.
      const arrivedAt = new Date().toISOString();
      // Liveness is counted here, on the RAW frame, and NOT further down past
      // `changedOnly()`. The dedupe suppresses unchanged snapshots, so a quiet
      // venue forwards almost nothing while still sending a frame every second.
      // Counting forwards would make an idle hour look like a dead socket.
      lastFrameAtMs = Date.now();
      frames++;
      const raw = isBinary ? data.toString("utf8") : data.toString("utf8");

      // A zero-length frame now means something is wrong with the client,
      // not a keep-alive — `ws` inflates properly, so real frames have a
      // payload. Warn loudly rather than swallowing it like the old code.
      if (raw.length === 0) {
        console.warn("[kart-bridge] zero-length frame — decoding may be broken");
        return;
      }

      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Leave as raw string — webhook still gets it
      }

      // BcStart's first reply is typically a JSON ARRAY (catch-up dump
      // of recent races, lap times, etc.). Subsequent broadcasts can be
      // single objects OR arrays. Detect both shapes for useful logging.
      let typeLabel = "raw";
      if (Array.isArray(parsed)) {
        const counts = new Map<string, number>();
        for (const item of parsed) {
          const t =
            typeof item === "object" && item !== null && "$type" in item
              ? String((item as Record<string, unknown>).$type)
              : "raw";
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
        const summary = [...counts.entries()].map(([t, n]) => `${t}x${n}`).join(",");
        typeLabel = `array(${parsed.length}:${summary})`;
      } else if (typeof parsed === "object" && parsed !== null && "$type" in parsed) {
        typeLabel = String((parsed as Record<string, unknown>).$type);
      }

      // The stream repeats its whole snapshot every second; only forward
      // what moved, or the webhook drowns. PROBE still sees everything.
      const fresh = changedOnly(parsed);
      if (fresh === null) {
        debug(`unchanged snapshot (${typeLabel}) — not forwarded`);
        if (PROBE_MODE) console.log(`[kart-bridge:PROBE] unchanged ${typeLabel}`);
        return;
      }
      const freshCount = Array.isArray(fresh) ? fresh.length : 1;
      const totalCount = Array.isArray(parsed) ? parsed.length : 1;
      console.log(
        `[kart-bridge] message type=${typeLabel} bytes=${raw.length} forwarding=${freshCount}/${totalCount}`,
      );
      debug("payload:", fresh);
      enqueueForward(fresh, arrivedAt);
    });

    ws.on("error", (err: Error) => {
      // `ws` emits a real Error here (the built-in client emitted a bare
      // Event, which is why this used to log almost nothing useful).
      console.error(`[kart-bridge] WebSocket error: ${err.message}`);
      endReason = `error: ${err.message}`;
      // Terminate rather than trusting the socket to close itself. `ws` does
      // normally emit `close` after `error`, but this promise only settles on
      // `close` — so on the one path where it did not, the bridge would hang
      // forever holding a dead socket. That is the failure we are here to end.
      clearTimers();
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      if (closed) return;
      closed = true;
      clearTimers();
      const openMs = openedAtMs === 0 ? 0 : Date.now() - openedAtMs;
      console.log(
        `[kart-bridge] WebSocket closed code=${code} reason=${reason?.toString() || "(no reason)"} ` +
          `frames=${frames} openMs=${openMs} why="${endReason}"`,
      );
      // A reconnect re-sends BcStart and the server replays its full
      // snapshot; clear the dedupe cache so that replay is forwarded once
      // rather than silently dropped as "unchanged".
      //
      // That replay is what fed the race clock a false green flag on 2026-08-15
      // (see apps/web/src/features/racing/race-clock.ts). The fix belongs on the
      // consumer, which now compares RecordVersion — NOT here. Swallowing the
      // replay instead would trade that bug for the one this line was added to
      // fix: a reconnect that silently drops everything it missed.
      lastSeen.clear();
      resolve({ frames, openMs, reason: endReason });
    });

    // WATCHDOG 1 — never reached `open`. Distinct from the other two because
    // there is no session yet to report on, so this REJECTS and the backoff
    // grows rather than resetting.
    connectTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        console.error(`[kart-bridge] connect watchdog fired after ${CONNECT_TIMEOUT_MS / 1000}s`);
        clearTimers();
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        if (!closed) {
          closed = true;
          reject(new Error("connection stalled"));
        }
      }
    }, CONNECT_TIMEOUT_MS);
  });
}

/**
 * Main loop — connect, consume, reconnect with exponential backoff
 * on disconnect.
 *
 * The backoff resets ONLY after a session that actually worked. It used to
 * reset on any clean close, which meant a socket that opened and died
 * immediately retried roughly once a second forever, indistinguishable in the
 * logs from a healthy bridge doing nothing.
 *
 * The reconnect counter is here so that flapping is legible after the fact.
 * On 2026-08-15 the bridge never went dark for more than 50 seconds at a
 * stretch, so nothing short of counting reconnects showed the pattern — and the
 * dropped green flag that came out of it cost a race its clock.
 */
async function main(): Promise<void> {
  console.log("[kart-bridge] starting", {
    wsUrl: WS_URL,
    webhook: WEBHOOK_URL,
    probeMode: PROBE_MODE,
    logLevel: LOG_LEVEL,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    pingIntervalMs: PING_INTERVAL_MS,
    idleFrameTimeoutMs: IDLE_FRAME_TIMEOUT_MS,
  });
  // A new bootId in the session log is how the reader knows the process itself
  // was replaced, rather than the socket having healed in place.
  void reportSession({
    event: "boot",
    bootId: BOOT_ID,
    reconnects: 0,
    at: new Date().toISOString(),
  });
  let backoff = 1000;
  let reconnects = 0;
  while (true) {
    let ended: Pick<SessionReport, "frames" | "openMs" | "healthy" | "reason">;
    try {
      const session = await consumeStream();
      // "Worked" means it carried DATA and stayed up. A socket that opens,
      // delivers nothing and closes is a failure wearing a clean exit code.
      const healthy = session.frames > 0 && session.openMs >= HEALTHY_SESSION_MS;
      if (healthy) backoff = 1000;
      console.log(
        `[kart-bridge] session ended: frames=${session.frames} openMs=${session.openMs} ` +
          `healthy=${healthy} reason="${session.reason}"`,
      );
      ended = {
        frames: session.frames,
        openMs: session.openMs,
        healthy,
        reason: session.reason,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[kart-bridge] stream errored:", msg);
      // The connect watchdog rejects rather than resolving, so this branch is
      // "never reached open" — it still belongs in the log, and its absence
      // would read as a healthy stretch.
      ended = { frames: 0, openMs: 0, healthy: false, reason: `threw: ${msg}` };
    }
    reconnects++;
    const jitter = Math.floor(Math.random() * 1000);
    const delay = Math.min(backoff + jitter, 5 * 60 * 1000);
    console.log(`[kart-bridge] reconnect #${reconnects} in ${delay}ms (backoff ${backoff}ms)`);
    // Deliberately NOT awaited: the report is capped at 5s, and blocking a
    // reconnect on telemetry would let the slow webhook lengthen the outage it
    // is reporting. Every failure inside is swallowed.
    void reportSession({
      event: "session-end",
      bootId: BOOT_ID,
      reconnects,
      at: new Date().toISOString(),
      ...ended,
      nextDelayMs: delay,
    });
    await sleep(delay);
    backoff = Math.min(backoff * 2, 5 * 60 * 1000);
  }
}

process.on("SIGTERM", () => {
  console.log("[kart-bridge] SIGTERM — shutting down");
  process.exit(0);
});
process.on("SIGINT", () => {
  console.log("[kart-bridge] SIGINT — shutting down");
  process.exit(0);
});

main().catch((err) => {
  console.error("[kart-bridge] fatal:", err);
  process.exit(1);
});
