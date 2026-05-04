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
 *   PROBE              "1" → log every parsed message to stdout AND
 *                      forward to webhook. Default behavior also forwards;
 *                      this just adds verbose stdout dumps for debugging.
 *   LOG_LEVEL          "debug" → log raw frames + reconnect timing
 *
 * Reconnect: exponential backoff (1s → 5min cap) on ws errors / closes.
 * Subscription resend: BcStart fires on every successful open.
 */

const WS_URL = process.env.WS_URL ?? "ws://68.171.192.138:10001";
const WEBHOOK_URL = required("WEBHOOK_URL");
const WEBHOOK_SECRET = required("WEBHOOK_SECRET");
const PROBE_MODE = process.env.PROBE === "1";
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

// SMS-Timing / Tournament Manager broadcast subscription. Sent on
// every successful WebSocket open. Matches the protocol the user
// captured from their kart timing client. `Timing: "false"` is a
// string (not boolean) intentionally — server uses .NET-style JSON.
const BC_START_MESSAGE = {
  $type: "BcStart",
  Timing: "false",
  Notifications: "true",
  Resource: "Red Track",
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
 * Open the WebSocket, send BcStart, and forward every inbound
 * message until the connection closes. Uses Node's built-in
 * WebSocket global (Node 22+).
 */
async function consumeStream(): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let closed = false;

    ws.addEventListener("open", () => {
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

    ws.addEventListener("message", (ev) => {
      // Frames may be string or Buffer/ArrayBuffer depending on the
      // server's content-type. Stringify for downstream forwarding.
      let raw: string;
      if (typeof ev.data === "string") raw = ev.data;
      else if (ev.data instanceof ArrayBuffer)
        raw = new TextDecoder().decode(ev.data);
      else raw = String(ev.data);

      // The server emits empty data frames as keep-alives between real
      // messages (~1/sec). They're not actionable — drop them before
      // doing any work or forwarding them to the webhook.
      if (raw.length === 0) {
        debug("empty keep-alive frame");
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
        const summary = [...counts.entries()]
          .map(([t, n]) => `${t}x${n}`)
          .join(",");
        typeLabel = `array(${parsed.length}:${summary})`;
      } else if (
        typeof parsed === "object" &&
        parsed !== null &&
        "$type" in parsed
      ) {
        typeLabel = String((parsed as Record<string, unknown>).$type);
      }

      console.log(`[kart-bridge] message type=${typeLabel} bytes=${raw.length}`);
      debug("payload:", parsed);
      forward(parsed).catch((err) =>
        console.error("[kart-bridge] forward threw:", err),
      );
    });

    ws.addEventListener("error", (ev) => {
      // Node 22's undici WebSocket dispatches a generic Event on error
      // (NOT a browser-style ErrorEvent — that constructor isn't a
      // global in Node, hence the original `instanceof ErrorEvent`
      // crashed with ReferenceError). Log the event type and let
      // the close handler resolve with details (code + reason).
      const evtType = (ev as { type?: string } | null)?.type ?? "unknown";
      console.error(`[kart-bridge] WebSocket error event (type=${evtType})`);
    });

    ws.addEventListener("close", (ev) => {
      if (closed) return;
      closed = true;
      console.log(
        `[kart-bridge] WebSocket closed code=${ev.code} reason=${ev.reason || "(no reason)"}`,
      );
      resolve();
    });

    // 30s safety timeout on the ws connection itself — if open
    // never fires, abort and let the reconnect loop try again.
    const watchdog = setTimeout(() => {
      if (ws.readyState === ws.CONNECTING) {
        console.error("[kart-bridge] open watchdog fired — connection stalled");
        try {
          ws.close();
        } catch { /* ignore */ }
        if (!closed) {
          closed = true;
          reject(new Error("connection stalled"));
        }
      }
    }, 30_000);

    ws.addEventListener("open", () => clearTimeout(watchdog));
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
