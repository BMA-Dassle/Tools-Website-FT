/**
 * Intercard Enhanced 3rd Party Interface client — CLOUD, raw TCP.
 *
 * Speaks the `iEnhancedInterfaceRequest` XML protocol from
 * docs/intercard-enhanced-3rd-party-interface-v7.pdf: open a TCP socket to the
 * Transaction Server, write the request buffer, read one
 * `iEnhancedInterfaceResponse`. Same protocol the on-prem bridge
 * (game-card-bridge/lib.mjs) uses for CreditAccounts — this is the server-side
 * (Vercel nodejs runtime) client pointed at the CLOUD-hosted Transaction Server
 * (host via INTERCARD_EIS_HOST, spec p.2: "IP Addresses and port numbers must be
 * configurable on site").
 *
 * Currently carries ConsolidateCards (spec p.27-28): move ALL values of one or
 * more source cards onto a "primary/single" target card, atomically, server-side.
 *
 * DEDUP (spec p.2): "A transaction with the same MacAddress and UTCDateTime as a
 * previous transaction is considered a duplicate transaction and will not be
 * processed." There is NO id-based idempotency — every attempt gets a fresh
 * millisecond timestamp. A ConsolidateCards retry is still money-safe because the
 * op moves ALL value: if the first attempt landed, the source is already empty
 * and the retry moves nothing; if it didn't, the retry performs the move.
 *
 * Account numbers are bigint strings end-to-end — never Number() them.
 */
import net from "node:net";
import { macForCenter, eisHostForCenter, INTERCARD_EIS_PORT } from "~/config/intercard-centers";
import { IntercardError } from "./intercard";

const EIS_TIMEOUT_MS = 30_000;
const CENTER_TZ = "America/New_York"; // all corp-6283 sites are Eastern

/** Kiosk combine identity stamped on transactions (Intercard report audit trail). */
const KIOSK_EMP = { id: "KioskCombine", first: "Kiosk", last: "Combine" };

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Text of the first <tag>…</tag> in the reply (namespace-free protocol). */
export function eisTagText(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : null;
}

/**
 * LT_DateTime / UTC_DateTime pair in the spec's format (millisecond resolution
 * required): local Eastern wall time with UTC offset (e.g.
 * 2015-01-22T15:04:51.091-05:00) and the matching Zulu UTC stamp.
 */
export function eisStamps(now = new Date()): { lt: string; utc: string } {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: CENTER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  const y = Number(parts.year);
  const mo = Number(parts.month);
  const d = Number(parts.day);
  const h = Number(parts.hour === "24" ? "0" : parts.hour);
  const mi = Number(parts.minute);
  const s = Number(parts.second);
  const ms = now.getMilliseconds();
  // Offset = Eastern wall-clock reinterpreted as UTC minus the real instant
  // (-240 EDT / -300 EST) — no tz table needed.
  const offMin = Math.round((Date.UTC(y, mo - 1, d, h, mi, s, ms) - now.getTime()) / 60_000);
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const lt =
    `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}.${pad(ms, 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  const utc =
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T` +
    `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}.` +
    `${pad(ms, 3)}Z`;
  return { lt, utc };
}

/**
 * Build the ConsolidateCards request — element names/order verbatim from the
 * spec's XML example (p.28): TransactionRequest header, then
 * <ConsolidateCards><TargetAccount> + <ConsolidateSourceAccountList> of
 * <AccountNumber> items.
 */
export function consolidateCardsXml(params: {
  mac: string;
  targetAccount: string;
  sourceAccounts: string[];
  transactionId: string;
}): string {
  const { lt, utc } = eisStamps();
  const sources = params.sourceAccounts
    .map((a) => `<AccountNumber>${xmlEscape(a)}</AccountNumber>`)
    .join("");
  return (
    `<?xml version="1.0"?>` +
    `<iEnhancedInterfaceRequest xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">` +
    `<TransactionRequest>` +
    `<RequestType>ConsolidateCards</RequestType>` +
    `<MacAddress>${xmlEscape(params.mac)}</MacAddress>` +
    `<TransactionID>${xmlEscape(params.transactionId)}</TransactionID>` +
    `<EmployeeID>${KIOSK_EMP.id}</EmployeeID>` +
    `<EmployeeName><FirstName>${KIOSK_EMP.first}</FirstName><LastName>${KIOSK_EMP.last}</LastName></EmployeeName>` +
    `<LT_DateTime>${lt}</LT_DateTime>` +
    `<UTC_DateTime>${utc}</UTC_DateTime>` +
    `</TransactionRequest>` +
    `<ConsolidateCards>` +
    `<TargetAccount>${xmlEscape(params.targetAccount)}</TargetAccount>` +
    `<ConsolidateSourceAccountList>${sources}</ConsolidateSourceAccountList>` +
    `</ConsolidateCards>` +
    `</iEnhancedInterfaceRequest>`
  );
}

/**
 * One TCP round-trip: connect, write the request, read one
 * iEnhancedInterfaceResponse (or whatever arrived by close). Throws
 * IntercardError on connect/timeout trouble — the caller decides whether a
 * retry is safe for its operation.
 */
export function eisRequest(
  payload: string,
  opts: { host: string; port: number; timeoutMs?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buf = "";
    let settled = false;
    const done = (err: IntercardError | null, val?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(val ?? "");
    };
    socket.setTimeout(opts.timeoutMs ?? EIS_TIMEOUT_MS);
    socket.on("timeout", () => done(new IntercardError("EIS_TIMEOUT", "EIS socket timeout")));
    socket.on("error", (e) =>
      done(new IntercardError("EIS_NETWORK", e instanceof Error ? e.message : String(e))),
    );
    socket.on("data", (d) => {
      buf += d.toString("utf8");
      // One response then the server may hold the socket open — resolve on the
      // closing tag (CommandStatus close covers truncated namespace variants).
      if (/<\/iEnhancedInterfaceResponse>/i.test(buf) || buf.includes("</CommandStatus>")) {
        done(null, buf);
      }
    });
    socket.on("close", () => done(null, buf));
    socket.connect(opts.port, opts.host, () => {
      socket.write(payload);
    });
  });
}

export interface ConsolidateCardsParams {
  locationCode: number;
  /** The survivor card — receives all value. */
  targetAccount: string;
  /** Source cards whose ENTIRE balance moves onto the target. */
  sourceAccounts: string[];
  /** Our per-move id, echoed as <TransactionID> for the audit trail. */
  transactionId: string;
}

/** True when the cloud EIS host is configured for this center. */
export function eisConfigured(locationCode: number): boolean {
  return !!eisHostForCenter(locationCode) && !!macForCenter(locationCode);
}

/**
 * ConsolidateCards — move ALL value from the source card(s) onto the target in
 * one atomic Transaction Server op. Returns the CommandStatus:
 * code 0 = success, non-0 = error (description says why). Throws IntercardError
 * when the exchange itself failed (no parseable CommandStatus / network).
 */
export async function consolidateCards(
  params: ConsolidateCardsParams,
): Promise<{ code: number; description: string }> {
  const host = eisHostForCenter(params.locationCode);
  const mac = macForCenter(params.locationCode);
  if (!host) {
    throw new IntercardError("NO_EIS_HOST", "Intercard EIS host is not configured");
  }
  if (!mac) {
    throw new IntercardError("NO_MAC", "Intercard MAC is not configured for this location");
  }
  if (params.sourceAccounts.length === 0) {
    throw new IntercardError("NO_ACCOUNTS", "consolidateCards requires at least one source");
  }
  const payload = consolidateCardsXml({
    mac,
    targetAccount: params.targetAccount,
    sourceAccounts: params.sourceAccounts,
    transactionId: params.transactionId,
  });
  const reply = await eisRequest(payload, { host, port: INTERCARD_EIS_PORT });
  const raw = eisTagText(reply, "ResponseCode");
  const code = raw == null ? NaN : Number(raw);
  if (Number.isNaN(code)) {
    throw new IntercardError("BAD_RESPONSE", "Could not parse ConsolidateCards CommandStatus");
  }
  return { code, description: eisTagText(reply, "ResponseDescription") ?? "" };
}
