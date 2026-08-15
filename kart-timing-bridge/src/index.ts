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
 *
 * Reconnect: exponential backoff (1s → 5min cap) on ws errors / closes.
 * Subscription resend: BcStart fires on every successful open.
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
import { createHash } from "node:crypto";

const WS_URL = process.env.WS_URL ?? "ws://68.171.192.138:10001";
const WEBHOOK_URL = required("WEBHOOK_URL");
const WEBHOOK_SECRET = required("WEBHOOK_SECRET");
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
async function forward(message: unknown): Promise<void> {
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
          receivedAt: new Date().toISOString(),
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

function enqueueForward(message: unknown): void {
  queueDepth++;
  forwardChain = forwardChain
    .then(() => forward(message))
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

/**
 * Open the WebSocket, send BcStart, and forward every inbound
 * message until the connection closes.
 *
 * Uses the `ws` package, NOT Node's built-in WebSocket — see the header
 * comment. `ws` inflates permessage-deflate and reassembles continuation
 * frames; the built-in silently produces empty strings for both.
 */
async function consumeStream(): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { perMessageDeflate: true });
    let closed = false;

    ws.on("open", () => {
      console.log(`[kart-bridge] WebSocket open: ${WS_URL}`);
      try {
        ws.send(JSON.stringify(BC_START_MESSAGE));
        console.log(
          `[kart-bridge] sent BcStart (resource=${BC_START_MESSAGE.Resource}, groups=${BC_START_MESSAGE.NotificationGroups.join(",")})`,
        );
      } catch (err) {
        console.error("[kart-bridge] failed to send BcStart:", err);
      }
    });

    ws.on("message", (data: Buffer, isBinary: boolean) => {
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
      enqueueForward(fresh);
    });

    ws.on("error", (err: Error) => {
      // `ws` emits a real Error here (the built-in client emitted a bare
      // Event, which is why this used to log almost nothing useful).
      console.error(`[kart-bridge] WebSocket error: ${err.message}`);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      if (closed) return;
      closed = true;
      console.log(
        `[kart-bridge] WebSocket closed code=${code} reason=${reason?.toString() || "(no reason)"}`,
      );
      // A reconnect re-sends BcStart and the server replays its full
      // snapshot; clear the dedupe cache so that replay is forwarded once
      // rather than silently dropped as "unchanged".
      lastSeen.clear();
      resolve();
    });

    // 30s safety timeout on the ws connection itself — if open
    // never fires, abort and let the reconnect loop try again.
    const watchdog = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        console.error("[kart-bridge] open watchdog fired — connection stalled");
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        if (!closed) {
          closed = true;
          reject(new Error("connection stalled"));
        }
      }
    }, 30_000);

    ws.on("open", () => clearTimeout(watchdog));
  });
}

/**
 * Main loop — connect, consume, reconnect with exponential backoff
 * on disconnect.
 */
async function main(): Promise<void> {
  console.log("[kart-bridge] starting", {
    wsUrl: WS_URL,
    webhook: WEBHOOK_URL,
    probeMode: PROBE_MODE,
    logLevel: LOG_LEVEL,
  });
  let backoff = 1000;
  while (true) {
    try {
      await consumeStream();
      backoff = 1000; // clean disconnect — reconnect quickly
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[kart-bridge] stream errored:", msg);
    }
    const jitter = Math.floor(Math.random() * 1000);
    const delay = Math.min(backoff + jitter, 5 * 60 * 1000);
    console.log(`[kart-bridge] reconnecting in ${delay}ms`);
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
