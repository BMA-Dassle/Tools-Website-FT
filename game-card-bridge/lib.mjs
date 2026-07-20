/**
 * game-card-bridge core — the pieces testable without a live EIS server or
 * env config: XML build/parse, the raw TCP exchange, and the ack-outcome
 * classifier. server.mjs wires env + the localhost HTTP server + the cloud
 * queue worker around these.
 */
import net from "node:net";

export function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Local + UTC timestamps in the passport's exact formats. */
export function stamps() {
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
export function creditXml({ accountNumber, tokens, bonusTokens, employeeId, mac }) {
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

export function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : null;
}

/**
 * Open the raw TCP socket to the EIS server, send the request, read the reply.
 * Resolves { reply, attempted }; rejections carry err.attempted.
 *
 * `attempted` flips true the moment the request bytes are handed to the
 * socket — the web-reload queue's safety hangs on that distinction: a failure
 * BEFORE the write means the EIS definitively saw nothing (→ no_attempt, safe
 * to fall back to the cloud SOAP path); a failure AFTER means the outcome is
 * unknown (→ verify path, never blindly retried — the EIS protocol has no
 * idempotency id).
 */
export function eisRequest(payload, { ip, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buf = "";
    let settled = false;
    let attempted = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) {
        err.attempted = attempted;
        reject(err);
      } else {
        resolve({ reply: val, attempted });
      }
    };
    socket.setTimeout(timeoutMs);
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
    socket.connect(port, ip, () => {
      attempted = true;
      socket.write(payload);
    });
  });
}

/**
 * Credit one card on the EIS server. Config/input problems throw with
 * err.attempted=false (nothing was sent). Returns
 * { ok, code, description, raw, attempted } — code is null when the reply had
 * no parseable <ResponseCode>.
 */
export async function creditTokensEis({
  ip,
  port,
  timeoutMs,
  mac,
  accountNumber,
  tokens,
  bonusTokens,
  employeeId,
}) {
  if (!ip || !mac) {
    const e = new Error("bridge not configured (INTERCARD_IP / INTERCARD_MAC)");
    e.attempted = false;
    throw e;
  }
  const acct = String(accountNumber || "").replace(/[^0-9]/g, "");
  if (!acct) {
    const e = new Error("accountNumber required");
    e.attempted = false;
    throw e;
  }
  const payload = creditXml({ accountNumber: acct, tokens, bonusTokens, employeeId, mac });
  const { reply, attempted } = await eisRequest(payload, { ip, port, timeoutMs });
  const code = tagText(reply, "ResponseCode");
  const desc = tagText(reply, "ResponseDescription");
  return {
    ok: code === "0",
    code,
    description: desc ?? "",
    raw: reply.slice(0, 2000),
    attempted,
  };
}

/**
 * Map an EIS attempt to the queue ack outcome. Anything ambiguous is
 * 'unknown' — the cloud NEVER re-credits an unknown-outcome row; 'declined'
 * and 'no_attempt' both mean the EIS definitively did not credit, so the
 * cloud may hand the row to the SOAP fallback.
 */
export function classifyOutcome(res, err) {
  if (err) return err.attempted ? "unknown" : "no_attempt";
  if (res && res.code === "0") return "ok";
  if (res && res.code != null) return "declined";
  return "unknown"; // reply present but no parseable ResponseCode
}
