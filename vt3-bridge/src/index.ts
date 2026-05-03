/**
 * VT3 → webhook SSE bridge.
 *
 * Holds an always-open Server-Sent Events connection to
 * https://sys.vt3.io/videos/events and forwards each pushed event to
 * our Vercel webhook (POST {WEBHOOK_URL}) with a shared-secret
 * header. Designed to fit in a $0/mo Railway / Fly.io free-tier
 * machine (~256MB RAM, near-zero CPU).
 *
 * Why this exists: Vercel's serverless functions have a 60s ceiling
 * and can't hold a long-lived SSE connection. This worker runs
 * outside Vercel just to bridge the always-on stream into our
 * normal webhook-driven request/response model.
 *
 * Auth flow mirrors `fasttrax-web/lib/vt3.ts` — POST /auth/local
 * with username + password, get JWT good for 7 days, cache in
 * memory for 6 days, re-login on 401.
 *
 * Reliability:
 *  - Reconnect on stream errors with exponential backoff (1s -> 5min)
 *  - Force re-login on 401s
 *  - One retry per webhook delivery on transient failure
 *  - Persistent webhook failures get logged + dropped — the
 *    fasttrax-web cron (kept at slower cadence as backstop) catches
 *    misses.
 *
 * Required env vars:
 *   VT3_USERNAME       — same as fasttrax-web's VT3_USERNAME
 *   VT3_PASSWORD       — same as fasttrax-web's VT3_PASSWORD
 *   WEBHOOK_URL        — https://fasttraxent.com/api/webhooks/vt3-video-event
 *   WEBHOOK_SECRET     — shared with fasttrax-web's VT3_BRIDGE_SECRET
 *
 * Optional:
 *   PROBE              — when "1", logs every parsed event payload to
 *                        stdout and SKIPS webhook forwarding. Use this
 *                        to discover the actual event schema (HAR can't
 *                        capture SSE bodies). Run locally for ~30 min
 *                        during a busy race window, capture the output,
 *                        adjust the Vercel webhook handler accordingly.
 *   LOG_LEVEL          — "debug" emits raw frames + parsed payloads.
 */

const VT3_HOST = "https://sys.vt3.io";
const VT3_USER = required("VT3_USERNAME");
const VT3_PASS = required("VT3_PASSWORD");
const PROBE_MODE = process.env.PROBE === "1";
const WEBHOOK_URL = PROBE_MODE ? "" : required("WEBHOOK_URL");
const WEBHOOK_SECRET = PROBE_MODE ? "" : required("WEBHOOK_SECRET");
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

// Note on the ~10s SSE reconnect cycle observed in PROBE-mode logs:
// the stream consistently delivered ~5s of events, went idle for ~5s,
// then upstream closed it. That pattern is server-side — VT3's edge
// (CloudFront fronting Strapi) has a fixed idle / max-connection
// timeout. Client-side dispatcher tweaks don't help. The reconnect
// logic in main() handles it: clean disconnect → 1s backoff → reopen.
// Events lost during the ~150ms reconnect gap are caught by the
// fasttrax-web cron at /api/cron/video-match running as a backstop.

let jwt = "";
let jwtExpiresAt = 0;

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[vt3-bridge] missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

function debug(...args: unknown[]): void {
  if (LOG_LEVEL === "debug") console.log("[vt3-bridge:debug]", ...args);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function login(): Promise<void> {
  const res = await fetch(`${VT3_HOST}/auth/local`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cp-ui": "mui",
      "x-cp-ver": "v2.48.3",
    },
    body: JSON.stringify({ identifier: VT3_USER, password: VT3_PASS }),
  });
  if (!res.ok) {
    throw new Error(`vt3 login ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as { jwt?: string };
  if (!json.jwt) throw new Error("vt3 login returned no jwt");
  jwt = json.jwt;
  // VT3 tokens are 7d; refresh ours after 6d to leave headroom.
  jwtExpiresAt = Date.now() + 6 * 24 * 60 * 60 * 1000;
  console.log("[vt3-bridge] logged in, jwt valid 6 days");
}

async function ensureJwt(): Promise<string> {
  if (!jwt || Date.now() >= jwtExpiresAt) await login();
  return jwt;
}

/**
 * ACK back to VT3 — session-level keepalive, NOT per-event.
 *
 * HAR-confirmed shape: POST /sse/{sessionId}/ack with content-length:
 * 0 (empty body). The control panel fires this once on connection
 * establishment, then again on reconnect. We mirror that timing.
 *
 * Best-effort — failures don't tear down the stream.
 */
async function ack(sessionId: string): Promise<void> {
  if (!sessionId) return;
  try {
    const res = await fetch(`${VT3_HOST}/sse/${sessionId}/ack`, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        authorization: `Bearer ${jwt}`,
        "x-cp-ui": "mui",
        "x-cp-ver": "v2.48.3",
      },
      // No body — control panel sends content-length: 0.
    });
    if (!res.ok) debug(`ack non-200: ${res.status}`);
    else debug(`ack ok for session=${sessionId}`);
  } catch (err) {
    debug("ack threw (non-fatal):", err);
  }
}

/**
 * Forward one event to the Vercel webhook. One retry on transient
 * failure; persistent failures logged + dropped (cron backstop will
 * catch missed videos within 15 min).
 *
 * No-op in PROBE mode — events go to stdout instead.
 */
async function forward(payload: unknown): Promise<void> {
  if (PROBE_MODE) {
    console.log("[vt3-bridge:PROBE]", JSON.stringify(payload));
    return;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vt3-bridge-secret": WEBHOOK_SECRET,
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) return;
      console.warn(
        `[vt3-bridge] webhook ${res.status} attempt ${attempt + 1}: ${await res
          .text()
          .catch(() => "")}`,
      );
    } catch (err) {
      console.warn(`[vt3-bridge] webhook threw attempt ${attempt + 1}:`, err);
    }
    if (attempt === 0) await sleep(1000);
  }
  console.error("[vt3-bridge] webhook persistently failed; dropping event");
}

/**
 * Open the SSE stream and parse frames as they arrive. Manual parser
 * to keep the dep tree empty.
 *
 * SSE frame format:
 *   id: 1234
 *   event: videoCreated
 *   data: {"foo":"bar"}
 *   <blank line ends the frame>
 *
 * Comment lines (`:`-prefixed) are heartbeats — we ignore them but
 * count them in debug logs.
 *
 * Schema note: the actual event types VT3 emits are TBD. Probe mode
 * (PROBE=1) logs every payload so we can discover the schema. The
 * webhook handler on the Vercel side dispatches on `eventType` so
 * unrecognized events become no-ops there until we wire them up.
 */
async function consumeStream(): Promise<void> {
  const token = await ensureJwt();
  const res = await fetch(`${VT3_HOST}/videos/events`, {
    headers: {
      accept: "text/event-stream",
      authorization: `Bearer ${token}`,
      "x-cp-ui": "mui",
      "x-cp-ver": "v2.48.3",
    },
  });
  if (!res.ok || !res.body) {
    throw new Error(`vt3 events ${res.status}: ${await res.text().catch(() => "")}`);
  }
  console.log("[vt3-bridge] SSE connection open");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Captured from the first event payload that includes a sessionId
  // field (or via an `event: session` frame). Once captured we fire
  // the session-establish ACK once and then leave VT3 alone — control
  // panel HAR showed only 1 ACK per connection lifecycle.
  let sessionId = "";
  let sessionAcked = false;
  let frameCount = 0;
  let heartbeatCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      console.log(
        `[vt3-bridge] SSE stream closed by upstream (frames=${frameCount}, heartbeats=${heartbeatCount})`,
      );
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      if (!block.trim()) continue;
      // Heartbeat / comment frame — `: ping`, `: keepalive`, etc.
      if (block.split("\n").every((l) => l.startsWith(":") || l.trim() === "")) {
        heartbeatCount++;
        debug("heartbeat:", block);
        continue;
      }
      const event: { id?: string; event?: string; data?: string } = {};
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue; // comment
        if (line.startsWith("id:")) event.id = line.slice(3).trim();
        else if (line.startsWith("event:")) event.event = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          // SSE allows multi-line data — concatenate.
          event.data = (event.data ?? "") + line.slice(5).trim();
        }
      }
      if (!event.data) continue;
      frameCount++;

      let parsed: unknown = event.data;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        // Leave as raw string — webhook still receives it.
      }
      // Capture session id. PROBE-mode logs from prod confirmed the
      // shape: VT3 fires `event: connected` with `data:` being the
      // bare UUID string (not an object). Some payloads might also
      // include sessionId on object data — handle both shapes.
      if (!sessionId) {
        if (
          event.event === "connected" &&
          typeof parsed === "string" &&
          /^[0-9a-f-]{36}$/i.test(parsed)
        ) {
          sessionId = parsed;
        } else if (typeof parsed === "object" && parsed !== null) {
          const p = parsed as Record<string, unknown>;
          if (typeof p.sessionId === "string") sessionId = p.sessionId;
          else if (event.event === "session" && typeof p.id === "string")
            sessionId = p.id;
        }
        if (sessionId) console.log(`[vt3-bridge] captured sessionId=${sessionId}`);
      }
      console.log(
        `[vt3-bridge] event=${event.event ?? "message"} id=${event.id ?? "-"}`,
      );
      debug("payload:", parsed);
      await forward({
        eventType: event.event ?? "message",
        eventId: event.id,
        data: parsed,
      });
      // Fire the session-establish ACK once we know the session id.
      if (sessionId && !sessionAcked) {
        await ack(sessionId);
        sessionAcked = true;
      }
    }
  }
}

/**
 * Main loop — connect, consume, reconnect with exponential backoff
 * on disconnect. JWT failures force a re-login on the next attempt.
 */
async function main(): Promise<void> {
  console.log("[vt3-bridge] starting", {
    user: VT3_USER,
    webhook: PROBE_MODE ? "(probe mode — no forwarding)" : WEBHOOK_URL,
    logLevel: LOG_LEVEL,
    probeMode: PROBE_MODE,
  });
  let backoff = 1000;
  while (true) {
    try {
      await consumeStream();
      backoff = 1000; // clean disconnect — reconnect quickly
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[vt3-bridge] stream errored:", msg);
      if (/401/.test(msg)) {
        // JWT invalid — drop the cached token so the next loop logs
        // back in.
        jwt = "";
        jwtExpiresAt = 0;
      }
      const jitter = Math.floor(Math.random() * 1000);
      const delay = Math.min(backoff + jitter, 5 * 60 * 1000);
      console.log(`[vt3-bridge] reconnecting in ${delay}ms`);
      await sleep(delay);
      backoff = Math.min(backoff * 2, 5 * 60 * 1000);
    }
  }
}

process.on("SIGTERM", () => {
  console.log("[vt3-bridge] SIGTERM — shutting down");
  process.exit(0);
});
process.on("SIGINT", () => {
  console.log("[vt3-bridge] SIGINT — shutting down");
  process.exit(0);
});

main().catch((err) => {
  console.error("[vt3-bridge] fatal:", err);
  process.exit(1);
});
