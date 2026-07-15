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

import {
  INTERCARD_MAC,
  INTERCARD_TPI_URL,
  INTERCARD_BALANCE_URL,
} from "~/config/intercard-centers";
import type { CardBalance, VerifyResult } from "../types";

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

// ── SOAP transport ───────────────────────────────────────────────────────────

async function soapCall(url: string, opName: string, innerXml: string): Promise<string> {
  if (!INTERCARD_MAC) {
    throw new IntercardError("NO_MAC", "INTERCARD_MAC is not configured");
  }
  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xmlns:xsd="http://www.w3.org/2001/XMLSchema">` +
    `<soap:Body><${opName} xmlns="${TEMPURI}">${innerXml}</${opName}></soap:Body>` +
    `</soap:Envelope>`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOAP_TIMEOUT_MS);
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

function macXml(): string {
  return `<MAC_ID><string>${xmlEscape(INTERCARD_MAC)}</string></MAC_ID>`;
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
 */
export async function creditTokens(params: CreditTokensParams): Promise<{ code: number }> {
  const { locationCode, accountNumber, tokens, bonusTokens, tpiTransactionID } = params;
  const now = new Date();
  const stamp = sqlDateTime(now, CENTER_TZ);

  const creditAccountsXml =
    `<CreditAccounts><CreditAccount>` +
    `<AccountNumber>${accountNumber}</AccountNumber>` +
    `<Cash>0</Cash><BonusCash>0</BonusCash>` +
    `<Tokens>${tokens}</Tokens><BonusTokens>${bonusTokens}</BonusTokens>` +
    `<Points>0</Points>` +
    `<StartTime>${stamp}</StartTime><Duration>0</Duration><EndTime>${stamp}</EndTime>` +
    `<BlockedAccessID>0</BlockedAccessID>` +
    `</CreditAccount></CreditAccounts>`;

  const inner =
    macXml() +
    `<LocationID>${locationCode}</LocationID>` +
    `<tpiSessionID>${xmlEscape(params.sessionId || tpiTransactionID)}</tpiSessionID>` +
    `<tpiTransactionID>${xmlEscape(tpiTransactionID)}</tpiTransactionID>` +
    `<tpiEmployeeID>${BRIDGE_EMP.id}</tpiEmployeeID>` +
    `<tpiEmployeeFirstName>${BRIDGE_EMP.first}</tpiEmployeeFirstName>` +
    `<tpiEmployeeLastName>${BRIDGE_EMP.last}</tpiEmployeeLastName>` +
    timeDateMapXml("LT_DateTime", now, CENTER_TZ) +
    timeDateMapXml("UTC_DateTime", now, "UTC") +
    `<creditAccountsXML>${xmlEscape(creditAccountsXml)}</creditAccountsXML>`;

  const resp = await soapCall(INTERCARD_TPI_URL, "TPICreditAccounts", inner);
  const raw = extractTag(resp, "TPICreditAccountsResult");
  const code = raw == null ? NaN : Number(raw);
  if (Number.isNaN(code)) {
    throw new IntercardError("BAD_RESPONSE", "Could not parse TPICreditAccounts result");
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

  const inner =
    macXml() +
    `<Account>${accountNumber}</Account>` +
    `<LT_Datetime>${isoNow}</LT_Datetime>` +
    `<GMT_StartPeriod>2012-01-01T00:00:00</GMT_StartPeriod>` +
    `<GMT_EndPeriod>2035-01-01T00:00:00</GMT_EndPeriod>` +
    `<LocID>${loc}</LocID>` +
    `<LT_Diff>-4</LT_Diff>`;

  const resp = await soapCall(INTERCARD_BALANCE_URL, "AcountHistoryWithPhotoXML", inner);

  const resultRaw = extractTag(resp, "AcountHistoryWithPhotoXMLResult");
  const result = resultRaw == null ? NaN : Number(resultRaw);
  // Non-zero result or no balance block → treat as not found (do not charge).
  if (result !== 0 || !/<(?:\w+:)?AccountBalance\b/.test(resp)) {
    return { exists: false, accountNumber };
  }

  const num = (tag: string): number => {
    const v = extractTag(resp, tag);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const balance: CardBalance = {
    tokens: num("TokenBalance"),
    bonusTokens: num("TokenBonusBalance"),
    timeMinutes: num("TPLY_Duration"),
  };
  const rawName = (extractTag(resp, "Name") || "").replace(/[\s,]+/g, " ").trim();

  return { exists: true, accountNumber, balance, name: rawName || undefined };
}
