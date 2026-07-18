/**
 * Game-card bridge — runs on the KIOSK PC (which sits on the center LAN) and
 * loads tokens onto Intercard cards via the on-prem EIS transaction server
 * (raw TCP :3044, iEnhancedInterfaceRequest XML). Ported from SWFLPassport's
 * loadPassportToFun socket path (owner 2026-07-19: the cloud SOAP endpoint
 * propagates to the centers too slowly; the on-prem server is immediate).
 *
 * WHY a bridge: browsers can't open raw TCP, and our Vercel/cloud API can't
 * reach the private 10.x.x.x center LAN. The kiosk browser CAN reach this bridge
 * on localhost, and the bridge (on the LAN) reaches the local EIS server.
 *
 * The bridge is pinned to ONE center (its own LAN) via env — the kiosk only ever
 * loads at the center it lives in, so the MAC/IP are configured here, not sent by
 * the browser (the MAC is a secret and never leaves the PC).
 *
 * Run on each kiosk PC (Node 18+):
 *   INTERCARD_IP=10.48.2.2 INTERCARD_MAC=68EDA47E4B69 node server.mjs
 * (FastTrax FM shown; HeadPinz FM 10.43.2.2/989096D0F391; Naples 10.40.2.2/68EDA45A5F59)
 */
import http from "node:http";
import net from "node:net";

const PORT = Number(process.env.PORT || 4599);
const EIS_PORT = Number(process.env.INTERCARD_EIS_PORT || 3044);
const IP = process.env.INTERCARD_IP || "";
const MAC = process.env.INTERCARD_MAC || "";
const EMPLOYEE_ID = process.env.INTERCARD_EMPLOYEE_ID || "KioskBridge";
const SOCKET_TIMEOUT_MS = Number(process.env.INTERCARD_TIMEOUT_MS || 30_000);
// Only the kiosk web origin(s) may call the bridge (it's localhost, but be strict).
const ALLOW_ORIGIN = process.env.BRIDGE_ALLOW_ORIGIN || "*";

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Local + UTC timestamps in the passport's exact formats. */
function stamps() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const off = -now.getTimezoneOffset(); // minutes east of UTC
  const sign = off >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  const lt =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.` +
    `${pad(now.getMilliseconds(), 3)}${sign}${oh}:${om}`;
  const u = new Date(now.getTime());
  const utc =
    `${u.getUTCFullYear()}-${pad(u.getUTCMonth() + 1)}-${pad(u.getUTCDate())}T` +
    `${pad(u.getUTCHours())}:${pad(u.getUTCMinutes())}:${pad(u.getUTCSeconds())}.` +
    `${pad(u.getUTCMilliseconds(), 3)}Z`;
  return { lt, utc };
}

/** Build the EIS CreditAccounts request loading TOKENS (+ bonus) onto one card. */
function creditXml({ accountNumber, tokens, bonusTokens, employeeId, mac }) {
  const { lt, utc } = stamps();
  return (
    `<?xml version="1.0"?>` +
    `<iEnhancedInterfaceRequest xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">` +
    `<TransactionRequest>` +
    `<RequestType>CreditAccounts</RequestType>` +
    `<MacAddress>${xmlEscape(mac)}</MacAddress>` +
    `<EmployeeID>${xmlEscape(employeeId)}</EmployeeID>` +
    `<EmployeeName><FirstName>Kiosk</FirstName><LastName>Bridge</LastName></EmployeeName>` +
    `<LT_DateTime>${lt}</LT_DateTime>` +
    `<UTC_DateTime>${utc}</UTC_DateTime>` +
    `</TransactionRequest>` +
    `<CreditAccounts><CreditAccountsList><CreditAccount>` +
    `<AccountNumber>${xmlEscape(accountNumber)}</AccountNumber>` +
    `<Cash>0</Cash><CashBonus>0</CashBonus>` +
    `<Tokens>${Number(tokens) || 0}</Tokens><TokenBonus>${Number(bonusTokens) || 0}</TokenBonus>` +
    `<Points>0</Points><TP_Duration>0</TP_Duration>` +
    `</CreditAccount></CreditAccountsList></CreditAccounts>` +
    `</iEnhancedInterfaceRequest>`
  );
}

function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : null;
}

/** Open the raw TCP socket to the EIS server, send the request, read the reply. */
function eisRequest(payload) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buf = "";
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve(val);
    };
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    socket.on("timeout", () => done(new Error("EIS socket timeout")));
    socket.on("error", (e) => done(e));
    socket.on("data", (d) => {
      buf += d.toString("utf8");
      // The EIS server replies with one iEnhancedInterfaceResponse then may hold
      // the socket open; resolve as soon as we have the closing tag.
      if (/<\/iEnhancedInterfaceResponse>/i.test(buf) || buf.includes("</CommandStatus>")) {
        done(null, buf);
      }
    });
    socket.on("close", () => done(null, buf));
    socket.connect(EIS_PORT, IP, () => socket.write(payload));
  });
}

async function creditTokens(body) {
  if (!IP || !MAC) throw new Error("bridge not configured (INTERCARD_IP / INTERCARD_MAC)");
  const accountNumber = String(body.accountNumber || "").replace(/[^0-9]/g, "");
  if (!accountNumber) throw new Error("accountNumber required");
  const payload = creditXml({
    accountNumber,
    tokens: body.tokens,
    bonusTokens: body.bonusTokens,
    employeeId: EMPLOYEE_ID,
    mac: MAC,
  });
  const reply = await eisRequest(payload);
  const code = tagText(reply, "ResponseCode");
  const desc = tagText(reply, "ResponseDescription");
  return {
    ok: code === "0",
    code: code ?? "?",
    description: desc ?? "",
    raw: reply.slice(0, 2000),
  };
}

function send(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": ALLOW_ORIGIN,
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true, configured: !!(IP && MAC), ip: IP, eisPort: EIS_PORT });
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
        const result = await creditTokens(body);
        return send(res, result.ok ? 200 : 502, result);
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
