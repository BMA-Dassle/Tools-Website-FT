/**
 * Game-card bridge — runs on the KIOSK PC (which sits on the center LAN) and
 * loads tokens onto Intercard cards via the on-prem EIS transaction server
 * (raw TCP :3044, iEnhancedInterfaceRequest XML). Two front doors:
 *
 *  1. localhost HTTP :4599 (/credit, /health) — the kiosk web app's fast
 *     path, unchanged from day one.
 *  2. OUTBOUND queue worker — polls the cloud app for WEB reload credit jobs
 *     for THIS center (claim → local EIS credit → ack). No inbound connection
 *     exists anywhere; the bridge only dials out. Enable by setting
 *     GC_CLOUD_URL, GC_BRIDGE_SECRET and GC_LOCATION_CODE
 *     (12 HeadPinz FM | 6 HeadPinz Naples | 13 FastTrax FM).
 *
 * WHY a bridge: browsers can't open raw TCP, and our Vercel/cloud API can't
 * reach the private 10.x.x.x center LAN (the cloud SOAP credit works but
 * propagates to the center too slowly — owner 2026-07-19). The kiosk PC is on
 * the LAN, so it carries both paths. Pinned to ONE center via env — the MAC
 * is a secret and never leaves the PC.
 *
 * QUEUE SAFETY: the EIS credit has NO idempotency id. The worker never
 * retries a credit; it reports exactly what happened (ok / declined /
 * no_attempt / unknown) and the cloud state machine does the rest. An
 * 'unknown' must stay unknown — never re-run it, even by hand.
 *
 * Run on each kiosk PC (Node 18+):
 *   INTERCARD_IP=10.48.2.2 INTERCARD_MAC=68EDA47E4B69 node server.mjs
 * (FastTrax FM shown; HeadPinz FM 10.43.2.2/989096D0F391; Naples 10.40.2.2/68EDA45A5F59)
 */
import http from "node:http";
import os from "node:os";
import { creditTokensEis, classifyOutcome } from "./lib.mjs";

const PORT = Number(process.env.PORT || 4599);
const EIS_PORT = Number(process.env.INTERCARD_EIS_PORT || 3044);
const IP = process.env.INTERCARD_IP || "";
const MAC = process.env.INTERCARD_MAC || "";
const EMPLOYEE_ID = process.env.INTERCARD_EMPLOYEE_ID || "KioskBridge";
const SOCKET_TIMEOUT_MS = Number(process.env.INTERCARD_TIMEOUT_MS || 30_000);
// Only the kiosk web origin(s) may call the bridge (it's localhost, but be strict).
const ALLOW_ORIGIN = process.env.BRIDGE_ALLOW_ORIGIN || "*";

// ── Web-reload queue worker config (all three required to enable) ───────────
const GC_CLOUD_URL = (process.env.GC_CLOUD_URL || "").replace(/\/+$/, "");
const GC_BRIDGE_SECRET = process.env.GC_BRIDGE_SECRET || "";
const GC_LOCATION_CODE = Number(process.env.GC_LOCATION_CODE || 0);
const GC_POLL_MS = Number(process.env.GC_POLL_MS || 2500);
const WEB_EMPLOYEE_ID = process.env.INTERCARD_WEB_EMPLOYEE_ID || "WebReload";
const CLAIM_MAX = 3;
// Local bound on how far past the cloud lease (3 min) a slow batch may still
// write: jobs older than this are acked no_attempt WITHOUT touching the EIS.
const CLAIM_STALE_MS = 90_000;
const WORKER_ID = `${os.hostname()}-${process.pid}`;

const eisConfig = { ip: IP, port: EIS_PORT, timeoutMs: SOCKET_TIMEOUT_MS };

function send(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": ALLOW_ORIGIN,
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    // Chrome/Edge Private-Network-Access: an HTTPS kiosk page may only fetch
    // 127.0.0.1 if the preflight answers this — without it the browser blocks
    // the call and the kiosk silently falls back to the cloud path.
    "access-control-allow-private-network": "true",
    "cache-control": "no-store",
  });
  res.end(payload);
}

// ── localhost HTTP server (kiosk fast path) ──────────────────────────────────

const workerEnabled = !!(GC_CLOUD_URL && GC_BRIDGE_SECRET && GC_LOCATION_CODE);
let lastPollAt = null;
let lastJobAt = null;
let lastError = null;

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, {
      ok: true,
      configured: !!(IP && MAC),
      ip: IP,
      eisPort: EIS_PORT,
      worker: workerEnabled
        ? {
            enabled: true,
            workerId: WORKER_ID,
            locationCode: GC_LOCATION_CODE,
            lastPollAt,
            lastJobAt,
            lastError,
          }
        : { enabled: false },
    });
  }
  if (req.method === "POST" && req.url === "/credit") {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(data || "{}");
      } catch {
        return send(res, 400, { ok: false, error: "invalid JSON" });
      }
      try {
        const r = await creditTokensEis({
          ...eisConfig,
          mac: MAC,
          accountNumber: body.accountNumber,
          tokens: body.tokens,
          bonusTokens: body.bonusTokens,
          employeeId: EMPLOYEE_ID,
        });
        console.log(
          `[kiosk-credit] card=${String(body.accountNumber || "").replace(/[^0-9]/g, "")} ` +
            `${Number(body.tokens) || 0}+${Number(body.bonusTokens) || 0}` +
            ` → ${r.ok ? "ok" : `fail(${r.code ?? "?"})`}`,
        );
        return send(res, r.ok ? 200 : 502, {
          ok: r.ok,
          code: r.code ?? "?",
          description: r.description,
          raw: r.raw,
        });
      } catch (e) {
        return send(res, 502, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
    return;
  }
  send(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[game-card-bridge] listening on http://127.0.0.1:${PORT} → EIS ${IP || "(unset)"}:${EIS_PORT} ` +
      `MAC ${MAC ? MAC.slice(0, 4) + "…" : "(unset)"}`,
  );
});

// ── Outbound queue worker (web reloads) ──────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cloudPost(path, payload) {
  const res = await fetch(`${GC_CLOUD_URL}${path}`, {
    method: "POST",
    // Secret goes in BOTH the header and the body: center firewalls with SSL
    // inspection have been seen stripping custom request headers; the JSON
    // body field survives. The cloud accepts either.
    headers: { "content-type": "application/json", "x-gc-bridge-secret": GC_BRIDGE_SECRET },
    body: JSON.stringify({ ...payload, secret: GC_BRIDGE_SECRET }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return res.json();
}

/**
 * Ack with retries. Any 2xx is final (applied:false just means the cloud
 * already moved the row on). Total failure only logs — the cloud lease flips
 * the row to 'verify' and resolves it from history. NEVER re-credit here.
 */
async function ackJob(payload) {
  for (let i = 0; i < 3; i++) {
    try {
      await cloudPost("/api/game-card-bridge/ack", payload);
      return true;
    } catch (e) {
      if (i < 2) await sleep(2000);
      else
        console.error(
          `[gc-worker] ack failed txn=${payload.txnId}: ${e.message} — leaving to the cloud lease`,
        );
    }
  }
  return false;
}

async function runJob(job, claimedAtMs) {
  let outcome;
  let code = null;
  let description = null;
  if (Date.now() - claimedAtMs > CLAIM_STALE_MS) {
    outcome = "no_attempt";
    code = "stale";
    description = "claim exceeded the bridge's local staleness bound";
  } else {
    let result = null;
    let err = null;
    try {
      result = await creditTokensEis({
        ...eisConfig,
        mac: MAC,
        accountNumber: job.accountNumber,
        tokens: job.tokens,
        bonusTokens: job.bonusTokens,
        employeeId: WEB_EMPLOYEE_ID,
      });
    } catch (e) {
      err = e;
    }
    outcome = classifyOutcome(result, err);
    code = result ? result.code : null;
    description = result ? result.description : err ? err.message : null;
  }
  console.log(
    `[gc-worker] txn=${job.txnId} card=${job.accountNumber} ${job.tokens}+${job.bonusTokens}` +
      ` → ${outcome}${code ? ` (${code})` : ""}`,
  );
  await ackJob({
    txnId: job.txnId,
    workerId: WORKER_ID,
    outcome,
    code: code ? String(code).slice(0, 16) : undefined,
    description: description ? String(description).slice(0, 300) : undefined,
  });
}

async function pollOnce() {
  const claimedAtMs = Date.now();
  const data = await cloudPost("/api/game-card-bridge/claim", {
    locationCode: GC_LOCATION_CODE,
    workerId: WORKER_ID,
    max: CLAIM_MAX,
  });
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  if (jobs.length) lastJobAt = new Date().toISOString();
  for (const job of jobs) await runJob(job, claimedAtMs); // serial — one EIS socket at a time
  return jobs.length;
}

let backoffMs = 0;
function schedulePoll(delayMs) {
  setTimeout(async () => {
    let next = GC_POLL_MS;
    try {
      const n = await pollOnce();
      lastPollAt = new Date().toISOString();
      lastError = null;
      backoffMs = 0;
      if (n > 0) next = 250; // drain quickly while the queue is non-empty
    } catch (e) {
      backoffMs = Math.min(backoffMs ? backoffMs * 2 : 5_000, 60_000);
      next = backoffMs;
      lastError = e instanceof Error ? e.message : String(e);
      console.error(`[gc-worker] poll failed: ${lastError} — next try in ${next}ms`);
    }
    // Re-arm ALWAYS — the kiosk /credit server must outlive any cloud outage.
    schedulePoll(next);
  }, delayMs);
}

if (workerEnabled) {
  console.log(
    `[gc-worker] web-reload queue: polling ${GC_CLOUD_URL} every ${GC_POLL_MS}ms ` +
      `as ${WORKER_ID} (center ${GC_LOCATION_CODE})`,
  );
  schedulePoll(GC_POLL_MS);
} else {
  console.log(
    "[gc-worker] web-reload queue disabled " +
      "(set GC_CLOUD_URL, GC_BRIDGE_SECRET, GC_LOCATION_CODE to enable)",
  );
}
