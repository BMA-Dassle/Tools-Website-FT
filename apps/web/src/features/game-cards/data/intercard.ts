/**
 * Generic Intercard SOAP client (corp 6283 / WS_ThirdPartyInterface).
 *
 * Hand-rolled envelope + fetch (matches the repo's no-SDK Square style). The
 * envelope shape here was verified against the LIVE service (a real
 * TPICreditAccounts load + refund on a test card): MAC_ID is an array of
 * <string> items, TimeDateMap = {Year,Month,Day,Hour,Minute,Second,Millisecond},
 * creditAccountsXML is an entity-escaped XML string, and the result is a bare
 * integer (0 = success, -1 = server exception, -2 = MAC not registered).
 *
 * Kept free of card-reload/web coupling (generic Intercard ops only) so it can
 * be promoted to a shared `@ft/intercard` package if booking later sells new
 * cards via TPI_PackageSale / bulk-encode.
 *
 * Account numbers are strings end-to-end (bigint precision). Money is invariant
 * decimals. Auth is the MAC alone.
 */

import { macForCenter, INTERCARD_TPI_URL, INTERCARD_BALANCE_URL } from "~/config/intercard-centers";
import type { CardBalance, CardTxn, VerifyResult } from "../types";

const TEMPURI = "http://tempuri.org/";
const SOAP_TIMEOUT_MS = 20_000;

export class IntercardError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "IntercardError";
  }
}

// ── XML helpers ────────────────────────────────────────────────────────────

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Extract the text content of the first <tag>…</tag> (namespace-insensitive). */
function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function soapFaultString(xml: string): string | null {
  return extractTag(xml, "faultstring");
}

/** All inner bodies of a repeated <tag>…</tag> element (namespace-insensitive). */
function extractAllBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** Wall-clock parts for a Date in a given IANA time zone. */
function zonedParts(dt: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(dt)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    ms: dt.getMilliseconds(),
  };
}

function timeDateMapXml(elementName: string, dt: Date, timeZone: string): string {
  const p = zonedParts(dt, timeZone);
  return (
    `<${elementName}>` +
    `<Year>${p.year}</Year><Month>${p.month}</Month><Day>${p.day}</Day>` +
    `<Hour>${p.hour}</Hour><Minute>${p.minute}</Minute><Second>${p.second}</Second>` +
    `<Millisecond>${p.ms}</Millisecond>` +
    `</${elementName}>`
  );
}

/** "yyyy-MM-dd HH:mm:ss" in a given time zone (Intercard XML date format). */
function sqlDateTime(dt: Date, timeZone: string): string {
  const p = zonedParts(dt, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

const CENTER_TZ = "America/New_York"; // all corp-6283 sites are Eastern

/**
 * Parse a history <TimeStamp> string to epoch ms. The AccountHistory feed
 * renders location-local Eastern wall time (we request LT_Diff -4); the exact
 * text format varies by server version, so accept both ISO-ish
 * ("2026-07-20T14:33:05" / "2026-07-20 14:33:05") and US
 * ("7/20/2026 2:33:05 PM") shapes. Returns null when unparseable — callers
 * MUST treat null as "no match" (the reconcile verify path fails toward
 * manual review, never toward a double credit).
 */
export function parseIntercardTimestamp(ts: string): number | null {
  const s = (ts || "").trim();
  if (!s) return null;
  let y: number, mo: number, d: number, h: number, mi: number, sec: number;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    y = +m[1];
    mo = +m[2];
    d = +m[3];
    h = +m[4];
    mi = +m[5];
    sec = +(m[6] ?? 0);
  } else {
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
    if (!m) return null;
    mo = +m[1];
    d = +m[2];
    y = +m[3];
    h = +m[4];
    mi = +m[5];
    sec = +(m[6] ?? 0);
    const ap = (m[7] || "").toUpperCase();
    if (ap === "PM" && h < 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
  }
  // The wall time is Eastern: find the UTC instant whose ET rendering matches
  // (try both possible offsets so DST needs no tz library; the once-a-year
  // fall-back ambiguity resolves to EDT, well inside the matcher's skew).
  for (const offH of [4, 5]) {
    const t = Date.UTC(y, mo - 1, d, h + offH, mi, sec);
    const p = zonedParts(new Date(t), CENTER_TZ);
    if (p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi) {
      return t;
    }
  }
  return null;
}

// ── SOAP transport ───────────────────────────────────────────────────────────

async function soapCall(
  url: string,
  opName: string,
  innerXml: string,
  mac: string,
  timeoutMs: number = SOAP_TIMEOUT_MS,
): Promise<string> {
  if (!mac) {
    throw new IntercardError("NO_MAC", "Intercard MAC is not configured for this location");
  }
  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xmlns:xsd="http://www.w3.org/2001/XMLSchema">` +
    `<soap:Body><${opName} xmlns="${TEMPURI}">${innerXml}</${opName}></soap:Body>` +
    `</soap:Envelope>`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: `"${TEMPURI}${opName}"`,
      },
      body: envelope,
      signal: controller.signal,
    });
  } catch (err) {
    throw new IntercardError(
      "NETWORK",
      err instanceof Error ? err.message : "Intercard request failed",
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    const fault = soapFaultString(text);
    throw new IntercardError("HTTP_" + res.status, fault || `Intercard HTTP ${res.status}`);
  }
  const fault = soapFaultString(text);
  if (fault) throw new IntercardError("SOAP_FAULT", fault);
  return text;
}

/** Bridge employee identity stamped on transactions (audit trail). */
const BRIDGE_EMP = {
  id: "WebReload",
  first: "Web",
  last: "Reload",
};

function macXml(mac: string): string {
  return `<MAC_ID><string>${xmlEscape(mac)}</string></MAC_ID>`;
}

// ── Operations ────────────────────────────────────────────────────────────────

export interface CreditTokensParams {
  locationCode: number;
  accountNumber: string;
  tokens: number;
  bonusTokens: number;
  /** Stable idempotency key — Intercard dedups on this (replay-safe). */
  tpiTransactionID: string;
  sessionId?: string;
}

/**
 * Credit tokens (+ bonus tokens) onto a card via TPICreditAccounts.
 * Returns the raw Intercard result code: 0 success, -1 server exception,
 * -2 MAC not registered. A duplicate tpiTransactionID returns 0 without
 * re-applying (server-side dedup) — safe to retry with the same id.
 *
 * Thin wrapper over creditAccountValues (cash/points/duration = 0) so the proven
 * token-reload path is byte-for-byte unchanged.
 */
export async function creditTokens(params: CreditTokensParams): Promise<{ code: number }> {
  return creditAccountValues({
    locationCode: params.locationCode,
    accountNumber: params.accountNumber,
    tokens: params.tokens,
    tokenBonus: params.bonusTokens,
    tpiTransactionID: params.tpiTransactionID,
    sessionId: params.sessionId,
  });
}

export interface CreditAccountValuesParams {
  locationCode: number;
  accountNumber: string;
  /** Any omitted value defaults to 0 (credits nothing of that kind). */
  cash?: number;
  cashBonus?: number;
  tokens?: number;
  tokenBonus?: number;
  points?: number;
  /** Time-play minutes to add. */
  durationMinutes?: number;
  /** Stable idempotency key — Intercard dedups on this (replay-safe). */
  tpiTransactionID: string;
  sessionId?: string;
}

/**
 * Credit ARBITRARY (dynamic) values onto a card via TPICreditAccounts — cash,
 * bonus cash, tokens, bonus tokens, points, and time-play minutes. This is the
 * "load dynamic values" half of consolidation: after reading a source card's
 * balance (verifyAccount), credit those exact amounts onto the target.
 *
 * Returns the raw result code (0 success, -1 server exception, -2 MAC not
 * registered). Idempotent on tpiTransactionID (a duplicate id returns 0 without
 * re-applying) — the caller MUST persist a stable id BEFORE calling and reuse it
 * on retry, or a retry double-credits. XML shape is the LIVE-verified
 * TPICreditAccounts creditAccountsXML (BonusCash / BonusTokens / Start-Duration-
 * End), NOT the EIS `iEnhancedInterfaceRequest` shape.
 */
export async function creditAccountValues(
  params: CreditAccountValuesParams,
): Promise<{ code: number }> {
  const { locationCode, accountNumber, tpiTransactionID } = params;
  const cash = params.cash ?? 0;
  const cashBonus = params.cashBonus ?? 0;
  const tokens = params.tokens ?? 0;
  const tokenBonus = params.tokenBonus ?? 0;
  const points = params.points ?? 0;
  const duration = params.durationMinutes ?? 0;
  const mac = macForCenter(locationCode); // per-location registration
  const now = new Date();
  const stamp = sqlDateTime(now, CENTER_TZ);

  const creditAccountsXml =
    `<CreditAccounts><CreditAccount>` +
    `<AccountNumber>${accountNumber}</AccountNumber>` +
    `<Cash>${cash}</Cash><BonusCash>${cashBonus}</BonusCash>` +
    `<Tokens>${tokens}</Tokens><BonusTokens>${tokenBonus}</BonusTokens>` +
    `<Points>${points}</Points>` +
    `<StartTime>${stamp}</StartTime><Duration>${duration}</Duration><EndTime>${stamp}</EndTime>` +
    `<BlockedAccessID>0</BlockedAccessID>` +
    `</CreditAccount></CreditAccounts>`;

  const inner =
    macXml(mac) +
    `<LocationID>${locationCode}</LocationID>` +
    `<tpiSessionID>${xmlEscape(params.sessionId || tpiTransactionID)}</tpiSessionID>` +
    `<tpiTransactionID>${xmlEscape(tpiTransactionID)}</tpiTransactionID>` +
    `<tpiEmployeeID>${BRIDGE_EMP.id}</tpiEmployeeID>` +
    `<tpiEmployeeFirstName>${BRIDGE_EMP.first}</tpiEmployeeFirstName>` +
    `<tpiEmployeeLastName>${BRIDGE_EMP.last}</tpiEmployeeLastName>` +
    timeDateMapXml("LT_DateTime", now, CENTER_TZ) +
    timeDateMapXml("UTC_DateTime", now, "UTC") +
    `<creditAccountsXML>${xmlEscape(creditAccountsXml)}</creditAccountsXML>`;

  const resp = await soapCall(INTERCARD_TPI_URL, "TPICreditAccounts", inner, mac);
  const raw = extractTag(resp, "TPICreditAccountsResult");
  const code = raw == null ? NaN : Number(raw);
  if (Number.isNaN(code)) {
    throw new IntercardError("BAD_RESPONSE", "Could not parse TPICreditAccounts result");
  }
  return { code };
}

export interface ClearAccountParams {
  locationCode: number;
  /** One or more account numbers (bigint strings) to clear. */
  accountNumbers: string[];
}

/**
 * Clear (de-register for re-issue) one or more accounts via TPI_ClearAccount —
 * the "clear the source card" half of consolidation, and the reuse-old-cards
 * step. Returns the raw result code (0 success, -1 server exception, -2 MAC not
 * registered).
 *
 * WHAT IT ACTUALLY DOES: TPI_ClearAccount *removes the account from the system*
 * ("so the cards can be re-issued" — spec), it does NOT merely zero the balance.
 * After a clear, verifyAccount returns exists:false; a subsequent creditTokens
 * on the same number RE-MATERIALIZES the account with only the new value (so the
 * clear→credit "clear-on-encode" sequence yields a clean card, no residual
 * stacking). All three behaviors confirmed live 2026-07-23 on a throwaway card.
 *
 * ⚠️ MONEY-SAFETY:
 *  - NOT idempotency-guarded (TPI_ClearAccount carries no transaction id). NEVER
 *    blind-retry an ambiguous/failed clear — re-query the account (verifyAccount)
 *    to see its real state, and only clear once the value is confirmed moved.
 *  - Only clear a SOURCE after its value is confirmed credited to the target.
 *
 * ⚠️ REUSE: Intercard recommends waiting ~24h before a cleared card is re-issued
 *    (spec, ClearCard §). Relevant to recycling binned cards as new-card stock.
 *    (Owner 2026-07-22: this guidance is intentionally ignored in clear-on-encode
 *    — we clear immediately before the credit.)
 */
export async function clearAccount(params: ClearAccountParams): Promise<{ code: number }> {
  const { locationCode, accountNumbers } = params;
  if (accountNumbers.length === 0) {
    throw new IntercardError("NO_ACCOUNTS", "clearAccount requires at least one account number");
  }
  const mac = macForCenter(locationCode);
  const now = new Date();

  // Array of account numbers. The item element is <long>, NOT <string>: the
  // Account array's items are AccountNumber (C# long / int64), unlike MAC_ID
  // whose items really are strings. A <string> item deserializes to an EMPTY
  // long[] server-side — the clear then no-ops but still returns 0 (a silent
  // "success" that clears nothing). VERIFIED live 2026-07-23: <long> clears,
  // <string> does not. Account numbers stay strings in JS (bigint precision);
  // the tag name is what matters to the .NET serializer, not the JS type.
  const accountsXml = accountNumbers.map((a) => `<long>${xmlEscape(a)}</long>`).join("");

  const inner =
    macXml(mac) +
    `<Account>${accountsXml}</Account>` +
    `<LocID>${locationCode}</LocID>` +
    `<tpiEmployeeID>${BRIDGE_EMP.id}</tpiEmployeeID>` +
    `<tpiEmployeeFirstName>${BRIDGE_EMP.first}</tpiEmployeeFirstName>` +
    `<tpiEmployeeLastName>${BRIDGE_EMP.last}</tpiEmployeeLastName>` +
    timeDateMapXml("LT_DateTime", now, CENTER_TZ) +
    timeDateMapXml("GMT_DateTime", now, "UTC");

  const resp = await soapCall(INTERCARD_TPI_URL, "TPI_ClearAccount", inner, mac);
  const raw = extractTag(resp, "TPI_ClearAccountResult");
  const code = raw == null ? NaN : Number(raw);
  if (Number.isNaN(code)) {
    throw new IntercardError("BAD_RESPONSE", "Could not parse TPI_ClearAccount result");
  }
  return { code };
}

export interface ConsolidateAccountsParams {
  locationCode: number;
  /** The survivor card — receives all value. Raw digit string. */
  targetAccount: string;
  /** Source cards whose ENTIRE balance moves onto the target. Raw digit strings. */
  sourceAccounts: string[];
  /** Stable idempotency key — Intercard dedups on this (replay-safe). */
  tpiTransactionID: string;
  sessionId?: string;
}

/**
 * TPI_ConsolidateAccounts — move ALL value (cash, bonus cash, tokens, bonus
 * tokens, points, time) of the source accounts onto the target, atomically,
 * on the SAME cloud SOAP host every other Intercard call uses. No bridge, no
 * raw sockets, no per-site hosts.
 *
 * Envelope is taken from the LIVE WSDL (fetched 2026-07-23 from
 * WS_ThirdPartyInterface.asmx?WSDL), not guessed — the first attempt failed on
 * three shape bugs the WSDL settles: sourceAccounts is ArrayOfLong (`<long>`
 * items, the same <string>-vs-<long> trap TPI_ClearAccount had), the location
 * element is `LocID` positioned AFTER the transaction ids (SOAP sequences are
 * order-sensitive), and the UTC stamp is `GMT_DateTime`.
 *
 * Returns the raw result code: 0 success, -1 server exception, -2 MAC not
 * registered. Idempotent on tpiTransactionID (duplicate id → 0 without
 * re-applying) — retry with the SAME id only. Timeout is tight (8s) because
 * the kiosk is holding the guest's card while this runs.
 */
export async function consolidateAccounts(
  params: ConsolidateAccountsParams,
): Promise<{ code: number }> {
  const { locationCode, targetAccount, sourceAccounts, tpiTransactionID } = params;
  if (sourceAccounts.length === 0) {
    throw new IntercardError("NO_ACCOUNTS", "consolidateAccounts requires a source account");
  }
  const mac = macForCenter(locationCode); // per-location registration
  const now = new Date();

  // WSDL sequence: MAC_ID, sourceAccounts, targetAccount, tpiSessionID,
  // tpiTransactionID, LocID, employee ids, LT_DateTime, GMT_DateTime.
  // Account numbers are raw text inside <long> — never Number() them in JS
  // (they're int64-scale; precision dies in a JS number round-trip).
  const sourcesXml = sourceAccounts.map((a) => `<long>${xmlEscape(a)}</long>`).join("");
  const inner =
    macXml(mac) +
    `<sourceAccounts>${sourcesXml}</sourceAccounts>` +
    `<targetAccount>${xmlEscape(targetAccount)}</targetAccount>` +
    `<tpiSessionID>${xmlEscape(params.sessionId || tpiTransactionID)}</tpiSessionID>` +
    `<tpiTransactionID>${xmlEscape(tpiTransactionID)}</tpiTransactionID>` +
    `<LocID>${locationCode}</LocID>` +
    `<tpiEmployeeID>${BRIDGE_EMP.id}</tpiEmployeeID>` +
    `<tpiEmployeeFirstName>${BRIDGE_EMP.first}</tpiEmployeeFirstName>` +
    `<tpiEmployeeLastName>${BRIDGE_EMP.last}</tpiEmployeeLastName>` +
    timeDateMapXml("LT_DateTime", now, CENTER_TZ) +
    timeDateMapXml("GMT_DateTime", now, "UTC");

  const resp = await soapCall(INTERCARD_TPI_URL, "TPI_ConsolidateAccounts", inner, mac, 8_000);
  const raw = extractTag(resp, "TPI_ConsolidateAccountsResult");
  const code = raw == null ? NaN : Number(raw);
  if (Number.isNaN(code)) {
    throw new IntercardError("BAD_RESPONSE", "Could not parse TPI_ConsolidateAccounts result");
  }
  return { code };
}

/**
 * Read-only account lookup for verify + balance display (Tokens / Bonus Tokens
 * / Time). Uses the WEB service — WS_AccountHistory `AcountHistoryWithPhotoXML`
 * (the op the Passport site used), NOT the on-prem socket BalanceInquiry.
 *
 * Field names + shape were captured off the LIVE service (2026-07-15) for a
 * real card, not assumed: the response's <AccountBalance> carries
 * <TokenBalance>, <TokenBonusBalance>, <TPLY_Duration> (time-play minutes),
 * <statusText>, <Name>, plus cash/point balances. Result code 0 = ok.
 *
 * Element order in the request follows the WSDL sequence:
 * MAC_ID, Account, LT_Datetime, GMT_StartPeriod, GMT_EndPeriod, LocID, LT_Diff.
 */
export async function verifyAccount(
  accountNumber: string,
  locationCode?: number,
): Promise<VerifyResult> {
  const now = new Date();
  const isoNow = sqlDateTime(now, "UTC").replace(" ", "T");
  const loc = locationCode ?? 12; // balance is account-global; LocID is just history context
  const mac = macForCenter(loc); // per-location registration

  const inner =
    macXml(mac) +
    `<Account>${accountNumber}</Account>` +
    `<LT_Datetime>${isoNow}</LT_Datetime>` +
    `<GMT_StartPeriod>2012-01-01T00:00:00</GMT_StartPeriod>` +
    `<GMT_EndPeriod>2035-01-01T00:00:00</GMT_EndPeriod>` +
    `<LocID>${loc}</LocID>` +
    `<LT_Diff>-4</LT_Diff>`;

  const resp = await soapCall(INTERCARD_BALANCE_URL, "AcountHistoryWithPhotoXML", inner, mac);

  const resultRaw = extractTag(resp, "AcountHistoryWithPhotoXMLResult");
  const result = resultRaw == null ? NaN : Number(resultRaw);
  // Non-zero result or no balance block → not found (do not charge). HOW we
  // know matters to the swipe-to-buy rail (blank-card.ts): probed LIVE
  // 2026-08-28 — an account Intercard has never seen answers result **1** with
  // an all-zero <AccountBalance> (Firstused 0001-01-01, no <statusText>); a
  // real card answers 0 with statusText Active/Expired; -1 is a server
  // exception and -2 an unregistered MAC. Only the 1 is a CONFIRMED absence
  // (a blank card has no account until its first credit); everything else is
  // ambiguous and must never be sold as "new".
  if (result !== 0 || !/<(?:\w+:)?AccountBalance\b/.test(resp)) {
    return { exists: false, accountNumber, notFound: result === 1 ? "confirmed" : "ambiguous" };
  }

  const num = (tag: string): number => {
    const v = extractTag(resp, tag);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const balance: CardBalance = {
    tokens: num("TokenBalance"),
    bonusTokens: num("TokenBonusBalance"),
    eTickets: num("PointBalance"),
    timeMinutes: num("TPLY_Duration"),
  };
  // Cash buckets (dollars) — not part of CardBalance (nothing displays them),
  // but a card holding cash is somebody's card: the swipe-to-buy blank check
  // must not read it as empty stock.
  const cashBalance = num("CashBalance") + num("BonusCashBalance");
  const rawName = (extractTag(resp, "Name") || "").replace(/[\s,]+/g, " ").trim();

  // Recent activity: each <AccountTransactions> block carries per-transaction
  // fields (confirmed live). Cap the list for display.
  const numIn = (block: string, tag: string): number => {
    const v = extractTag(block, tag);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  // A web reload posts to Intercard as a "Consolidation" credit — show it to
  // the guest as "Web" wherever it appears in history.
  const webify = (s: string) => s.replace(/consolidation/gi, "Web");
  const transactions: CardTxn[] = extractAllBlocks(resp, "AccountTransactions")
    .slice(0, 50)
    .map((b) => ({
      device: webify((extractTag(b, "Device") || "").trim()),
      transType: webify((extractTag(b, "TransType") || "").trim()),
      tokens: numIn(b, "Tokens"),
      bonusTokens: numIn(b, "TokenBonus"),
      points: numIn(b, "Points"),
      cash: numIn(b, "Cash"),
      timeStamp: (extractTag(b, "TimeStamp") || "").trim(),
      location: (extractTag(b, "Location") || "").trim(),
    }));

  return {
    exists: true,
    accountNumber,
    balance,
    name: rawName || undefined,
    transactions,
    ...(cashBalance > 0 ? { cashBalance } : {}),
  };
}
