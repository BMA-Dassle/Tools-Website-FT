/**
 * Intercard ONSITE client (corp 6283 / Api_External REST proxy).
 *
 * The sibling of `intercard.ts`. Same operations, same account/money semantics,
 * different transport and — crucially — a different SOURCE OF TRUTH:
 *
 *   intercard.ts        → SOAP, Intercard's DATACENTER copy (replicated).
 *   intercard-onsite.ts → REST, relayed live to the site's own Transaction
 *                         Server over SignalR (real-time truth).
 *
 * Verified live 2026-08-31 against HeadPinz Fort Myers (LocID 12): the same card
 * returns byte-identical balances through both paths, and this one additionally
 * carries blockedAccess / membership / time-play fields the SOAP shape omits.
 *
 * AUTH is NOT the MAC alone (that's the SOAP model). Api_External matches FOUR
 * values against its licensed-device table — `LocID` + `ProductCode` +
 * `ClientToken` headers plus the MAC in the BODY — and a mismatch on any one of
 * them yields the same generic 401 "ETPI requires up to date Licensing.".
 *
 * ⚠️ MAC FORMAT: the value must be the DB's exact string — uppercase, NO
 * separators (`00155D56DE02`). The colon form shown in Intercard's own settings
 * UI is rejected: the licence check is a plain string compare (the stored value
 * is only .Trim()'d — no separator stripping, no case folding). `normaliseMac`
 * enforces this so a colon-formatted secret can never silently 401.
 *
 * ⚠️ AVAILABILITY: unlike the SOAP path, a call can authenticate and STILL fail
 * when the site's relay is down (404 RELAY_OFFLINE / 504 RELAY_TIMEOUT). Callers
 * that must survive a site outage should fall back to the SOAP client; kiosks
 * (which are dead anyway if the site is down) can treat it as fatal.
 *
 * Account numbers are strings end-to-end (bigint precision — these exceed
 * Number.MAX_SAFE_INTEGER). Money is invariant decimals.
 */

import { request as httpsRequest } from "node:https";
import {
  macForCenter,
  INTERCARD_ONSITE_URL,
  intercardProductCode,
  intercardClientToken,
} from "~/config/intercard-centers";
import type { CardBalance, CardTxn, VerifyResult } from "../types";
import { IntercardError } from "./intercard";

const ONSITE_TIMEOUT_MS = 35_000; // the relay itself gives up at 30s
const CENTER_TZ = "America/New_York"; // all corp-6283 sites are Eastern

/** Bridge employee identity stamped on transactions (audit trail). */
const BRIDGE_EMP = {
  id: "WebReload",
  first: "Web",
  last: "Reload",
};

/**
 * Uppercase, separator-free MAC. The licence row is compared with a plain
 * string equality, so `00:15:5D:…` (the form Intercard's own UI displays) never
 * matches and 401s. Normalising here means a mis-formatted secret still works.
 */
export function normaliseMac(mac: string): string {
  return mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

// ── time helpers ─────────────────────────────────────────────────────────────

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
  };
}

/** "yyyy-MM-ddTHH:mm:ss" in a given time zone (the shape Api_External binds). */
function isoLocal(dt: Date, timeZone: string): string {
  const p = zonedParts(dt, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

// ── transport ────────────────────────────────────────────────────────────────

export interface TransactionRequestParams {
  locationCode: number;
  /** Free-text label, e.g. "BalanceInquiry". Not validated server-side. */
  requestType: string;
  /** Idempotency/correlation id. */
  transactionID: string;
  sessionId?: string;
  employeeId?: string;
}

/**
 * The envelope every operation shares. `sessionID` and `employeeID` are
 * [Required] non-empty server-side — an empty string 400s BEFORE the licence
 * check runs, so they are always populated here.
 */
function transactionRequest(mac: string, p: TransactionRequestParams) {
  const now = new Date();
  return {
    requestType: p.requestType,
    macAddress: mac,
    transactionID: p.transactionID,
    sessionID: p.sessionId || p.transactionID,
    employeeID: p.employeeId || BRIDGE_EMP.id,
    employeeName: { firstName: BRIDGE_EMP.first, lastName: BRIDGE_EMP.last },
    lT_DateTime: isoLocal(now, CENTER_TZ),
    utC_DateTime: isoLocal(now, "UTC"),
  };
}

/** Shape shared by every Api_External response. */
interface OnsiteEnvelope {
  responseCode: number;
  responseDescription: string;
}

/**
 * Minimal JSON-over-HTTPS request on `node:https`, NOT `fetch`.
 *
 * ⚠️ THIS IS NOT A STYLE CHOICE. Api_External declares its read operations
 * `[HttpGet]` while binding their payload `[FromBody]` — a GET that carries a
 * body. WHATWG `fetch` (undici, which is what Node and Next.js provide) rejects
 * that outright:
 *
 *     TypeError: Request with GET/HEAD method cannot have body.
 *
 * There is no option to opt out, and the operations are GET-only server-side
 * (a POST returns 405), so `fetch` cannot express this API's read half at all.
 * `node:https` has no such restriction. Caught by the live test script, which
 * is exactly the class of bug a stubbed-`fetch` unit test cannot see.
 *
 * Server-only by construction — this module is imported by services and API
 * routes (runtime "nodejs"), never by a client bundle.
 */
function httpJson(
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`Intercard onsite request timed out after ${timeoutMs}ms`));
    });
    req.write(body);
    req.end();
  });
}

/**
 * One call to the onsite proxy.
 *
 * NOTE the read operations are declared [HttpGet] yet bind their payload
 * [FromBody] — a GET *with* a body. That is the server's contract, not a
 * mistake here.
 *
 * Throws IntercardError for transport/auth/relay failures. A business-level
 * failure (responseCode !== 0 with HTTP 200) is returned to the caller, which
 * decides — `responseCode` is authoritative even on a 200.
 */
async function onsiteCall<T extends OnsiteEnvelope>(
  method: "GET" | "POST",
  operation: string,
  locationCode: number,
  body: unknown,
  timeoutMs: number = ONSITE_TIMEOUT_MS,
): Promise<T> {
  const mac = normaliseMac(macForCenter(locationCode));
  if (!mac) {
    throw new IntercardError("NO_MAC", "Intercard MAC is not configured for this location");
  }
  const token = intercardClientToken();
  if (!token) {
    throw new IntercardError("NO_TOKEN", "Intercard client token is not configured");
  }

  let res: { status: number; text: string };
  try {
    res = await httpJson(
      `${INTERCARD_ONSITE_URL}/api/v1/tpi/${operation}`,
      method,
      {
        "Content-Type": "application/json",
        Accept: "application/json",
        LocID: String(locationCode),
        ProductCode: intercardProductCode(),
        ClientToken: token,
      },
      JSON.stringify(body),
      timeoutMs,
    );
  } catch (err) {
    throw new IntercardError(
      "NETWORK",
      err instanceof Error ? err.message : "Intercard onsite request failed",
    );
  }

  const text = res.text;
  const ok = res.status >= 200 && res.status < 300;
  if (!ok) {
    // Distinguish the failure modes that matter operationally: a licence
    // problem is a config bug we must page on, whereas an offline relay is a
    // transient site-availability condition a caller may fall back from.
    if (res.status === 401) {
      throw new IntercardError(
        "NOT_LICENSED",
        "Intercard rejected the licence (LocID/ProductCode/ClientToken/MAC mismatch)",
      );
    }
    if (res.status === 404) {
      throw new IntercardError(
        "RELAY_OFFLINE",
        `No onsite Intercard relay connected for location ${locationCode}`,
      );
    }
    if (res.status === 504) {
      throw new IntercardError("RELAY_TIMEOUT", "Onsite Intercard relay did not respond in time");
    }
    throw new IntercardError("HTTP_" + res.status, `Intercard onsite HTTP ${res.status}`);
  }

  let parsed: T;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    throw new IntercardError("BAD_RESPONSE", `Could not parse ${operation} response`);
  }
  return parsed;
}

// ── operations ───────────────────────────────────────────────────────────────

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
  /** Stable idempotency key — persist BEFORE calling and reuse on retry. */
  tpiTransactionID: string;
  sessionId?: string;
}

/**
 * Credit values onto a card — the onsite twin of `creditAccountValues`.
 *
 * ⚠️ IDEMPOTENCY IS NOT GUARANTEED HERE THE WAY IT IS ON SOAP. The relay keys
 * its pending work by a server-generated GUID and performs NO dedup of its own;
 * whatever dedup exists lives further downstream in the Transaction Server. So
 * treat an ambiguous failure (RELAY_TIMEOUT / NETWORK / HTTP 5xx) as UNKNOWN,
 * NOT as "did not apply": re-read the balance before retrying, or you may
 * double-credit. Same rule the BMI/Intercard money paths already follow.
 */
export async function creditAccountValues(
  params: CreditAccountValuesParams,
): Promise<{ code: number }> {
  const { locationCode, accountNumber, tpiTransactionID } = params;
  const mac = normaliseMac(macForCenter(locationCode));
  const now = isoLocal(new Date(), CENTER_TZ);

  const res = await onsiteCall<OnsiteEnvelope>("POST", "creditaccounts", locationCode, {
    transactionRequest: transactionRequest(mac, {
      locationCode,
      requestType: "CreditAccounts",
      transactionID: tpiTransactionID,
      sessionId: params.sessionId,
    }),
    creditAccounts: {
      creditAccountsList: [
        {
          // Raw string — never Number() an account number (int64 precision).
          accountNumber,
          blockedAccessID: 0,
          cash: params.cash ?? 0,
          cashBonus: params.cashBonus ?? 0,
          tokens: params.tokens ?? 0,
          tokenBonus: params.tokenBonus ?? 0,
          points: params.points ?? 0,
          tP_Duration: params.durationMinutes ?? 0,
          tP_ActiveImmediate: false,
          activationDate: now,
          expirationDate: now,
        },
      ],
    },
  });
  return { code: res.responseCode };
}

export interface CreditTokensParams {
  locationCode: number;
  accountNumber: string;
  tokens: number;
  bonusTokens: number;
  /** Stable idempotency key. */
  tpiTransactionID: string;
  sessionId?: string;
}

/**
 * Credit tokens (+ bonus tokens) onto a card. Thin wrapper over
 * `creditAccountValues` so the token-reload path matches the SOAP client's
 * shape exactly (cash/points/duration = 0).
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

export interface ClearAccountParams {
  locationCode: number;
  /** One or more account numbers (bigint strings) to clear. */
  accountNumbers: string[];
  tpiTransactionID: string;
  sessionId?: string;
}

/**
 * Clear (de-register for re-issue) accounts — onsite twin of `clearAccount`.
 *
 * ⚠️ MONEY-SAFETY (identical to the SOAP path): a clear REMOVES the account, it
 * does not merely zero it, and it carries no idempotency guarantee. NEVER blind-
 * retry an ambiguous clear — re-query the account and only clear once the value
 * is confirmed moved. Only clear a SOURCE after the target credit is confirmed.
 */
export async function clearAccount(params: ClearAccountParams): Promise<{ code: number }> {
  const { locationCode, accountNumbers, tpiTransactionID } = params;
  if (accountNumbers.length === 0) {
    throw new IntercardError("NO_ACCOUNTS", "clearAccount requires at least one account number");
  }
  const mac = normaliseMac(macForCenter(locationCode));

  const res = await onsiteCall<OnsiteEnvelope>("POST", "clearcard", locationCode, {
    transactionRequest: transactionRequest(mac, {
      locationCode,
      requestType: "ClearCard",
      transactionID: tpiTransactionID,
      sessionId: params.sessionId,
    }),
    clearCard: { accountNumbersList: { accountNumbers } },
  });
  return { code: res.responseCode };
}

export interface ConsolidateAccountsParams {
  locationCode: number;
  /** The survivor card — receives all value. */
  targetAccount: string;
  /** Source cards whose ENTIRE balance moves onto the target. */
  sourceAccounts: string[];
  /** Stable idempotency key. */
  tpiTransactionID: string;
  sessionId?: string;
}

/**
 * Move ALL value from the source cards onto the target — onsite twin of
 * `consolidateAccounts`. Tight timeout: the kiosk holds the guest's card while
 * this runs.
 */
export async function consolidateAccounts(
  params: ConsolidateAccountsParams,
): Promise<{ code: number }> {
  const { locationCode, targetAccount, sourceAccounts, tpiTransactionID } = params;
  if (sourceAccounts.length === 0) {
    throw new IntercardError("NO_ACCOUNTS", "consolidateAccounts requires a source account");
  }
  const mac = normaliseMac(macForCenter(locationCode));

  const res = await onsiteCall<OnsiteEnvelope>(
    "POST",
    "consolidatecards",
    locationCode,
    {
      transactionRequest: transactionRequest(mac, {
        locationCode,
        requestType: "ConsolidateCards",
        transactionID: tpiTransactionID,
        sessionId: params.sessionId,
      }),
      consolidateCards: {
        targetAccount,
        consolidateSourceAccountList: { accountNumbers: sourceAccounts },
      },
    },
    8_000,
  );
  return { code: res.responseCode };
}

/** The `accountBalance` block Api_External returns (superset of the SOAP shape). */
interface OnsiteAccountBalance {
  accountNumber?: number | string;
  locID?: number;
  blockedAccessID?: number;
  registered?: boolean;
  firstName?: string;
  lastName?: string;
  cashBalance?: number;
  cashBonusBalance?: number;
  tokenBalance?: number;
  tokenBonusBalance?: number;
  pointBalance?: number;
  tpDuration?: number;
}

interface BalanceResponse extends OnsiteEnvelope {
  accountBalance?: OnsiteAccountBalance | null;
}

/**
 * Read-only account lookup — onsite twin of `verifyAccount`, and the main reason
 * to prefer this client at a kiosk: the balance is the site's REAL-TIME state,
 * not a replicated copy that can lag the physical readers.
 *
 * `notFound` mirrors the SOAP client's contract exactly, because the swipe-to-
 * buy rail sells a card as new ONLY on "confirmed":
 *   responseCode 0 + no balance block → "confirmed" (no such account)
 *   any non-zero responseCode         → "ambiguous" (absence NOT established)
 */
export async function verifyAccount(
  accountNumber: string,
  locationCode?: number,
): Promise<VerifyResult> {
  const loc = locationCode ?? 12; // balance is account-global; LocID is context
  const mac = normaliseMac(macForCenter(loc));

  const res = await onsiteCall<BalanceResponse>("GET", "balanceinquiry", loc, {
    transactionRequest: transactionRequest(mac, {
      locationCode: loc,
      requestType: "BalanceInquiry",
      transactionID: `verify-${accountNumber}`,
    }),
    balanceInquiry: { accountNumber },
  });

  if (res.responseCode !== 0) {
    // The service answered but errored — absence is NOT established.
    return { exists: false, accountNumber, notFound: "ambiguous" };
  }
  const b = res.accountBalance;
  if (!b) {
    return { exists: false, accountNumber, notFound: "confirmed" };
  }

  const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const balance: CardBalance = {
    tokens: num(b.tokenBalance),
    bonusTokens: num(b.tokenBonusBalance),
    eTickets: num(b.pointBalance),
    timeMinutes: num(b.tpDuration),
  };
  const cash = num(b.cashBalance) + num(b.cashBonusBalance);
  const name = [b.firstName, b.lastName]
    .filter(Boolean)
    .join(" ")
    .replace(/[\s,]+/g, " ")
    .trim();

  return {
    exists: true,
    accountNumber,
    balance,
    ...(cash > 0 ? { cashBalance: cash } : {}),
    ...(name ? { name } : {}),
  };
}

interface HistoryRow {
  deviceName?: string;
  transType?: string;
  actionType?: string;
  tokens?: number;
  tokenBonus?: number;
  points?: number;
  cash?: number;
  timeStamp?: string;
  location?: string;
}

interface HistoryResponse extends OnsiteEnvelope {
  accountHistory?: {
    accountBalance?: OnsiteAccountBalance | null;
    accountHistoryList?: HistoryRow[] | null;
  } | null;
}

/**
 * Recent on-card activity — onsite twin of the transactions half of
 * `verifyAccount`. Split out because the onsite proxy exposes balance and
 * history as separate operations (the SOAP service returned both at once), and
 * the reload page only needs history when the guest expands it.
 *
 * A web reload posts to Intercard as a "Consolidation" credit — shown to the
 * guest as "Web" wherever it appears, matching the SOAP client.
 */
export async function accountHistory(
  accountNumber: string,
  locationCode: number,
  opts: { startDate?: Date; endDate?: Date; limit?: number } = {},
): Promise<CardTxn[]> {
  const mac = normaliseMac(macForCenter(locationCode));
  const start = opts.startDate ?? new Date("2012-01-01T00:00:00Z");
  const end = opts.endDate ?? new Date(Date.now() + 24 * 60 * 60 * 1000);

  const res = await onsiteCall<HistoryResponse>("GET", "accounthistory", locationCode, {
    transactionRequest: transactionRequest(mac, {
      locationCode,
      requestType: "AccountHistory",
      transactionID: `history-${accountNumber}`,
    }),
    accountHistoryRequest: {
      accountNumber,
      historyStartDate: isoLocal(start, CENTER_TZ),
      historyEndDate: isoLocal(end, CENTER_TZ),
      localUTCOffset: -4,
    },
  });

  if (res.responseCode !== 0) return [];
  const rows = res.accountHistory?.accountHistoryList ?? [];
  const webify = (s: string) => s.replace(/consolidation/gi, "Web");
  const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  return rows.slice(0, opts.limit ?? 50).map((r) => ({
    device: webify((r.deviceName || "").trim()),
    transType: webify((r.transType || "").trim()),
    tokens: num(r.tokens),
    bonusTokens: num(r.tokenBonus),
    points: num(r.points),
    cash: num(r.cash),
    timeStamp: (r.timeStamp || "").trim(),
    location: (r.location || "").trim(),
  }));
}

/**
 * Liveness probe for a site's onsite relay — powers the kiosk's ONSITE/OFFLINE
 * badge. Uses `gamelist` because it is read-only, cheap, and (unlike a balance
 * lookup) needs no card number.
 *
 * Returns a discriminated status rather than throwing, because the badge must
 * render something for every failure mode:
 *   onsite       — relay connected, real-time path available
 *   offline      — licensed but no relay connected (404) / relay timed out
 *   unlicensed   — licence mismatch (401): a CONFIG bug, not a site outage
 *   error        — transport/unknown
 */
export type OnsiteStatus = "onsite" | "offline" | "unlicensed" | "error";

export async function probeOnsite(
  locationCode: number,
  timeoutMs = 8_000,
): Promise<{ status: OnsiteStatus; detail?: string }> {
  const mac = normaliseMac(macForCenter(locationCode));
  try {
    const res = await onsiteCall<OnsiteEnvelope>(
      "GET",
      "gamelist",
      locationCode,
      {
        transactionRequest: transactionRequest(mac, {
          locationCode,
          requestType: "GameList",
          transactionID: `probe-${locationCode}`,
        }),
      },
      timeoutMs,
    );
    return res.responseCode === 0
      ? { status: "onsite" }
      : { status: "error", detail: res.responseDescription };
  } catch (err) {
    if (err instanceof IntercardError) {
      if (err.code === "RELAY_OFFLINE" || err.code === "RELAY_TIMEOUT") {
        return { status: "offline", detail: err.message };
      }
      if (err.code === "NOT_LICENSED") return { status: "unlicensed", detail: err.message };
      return { status: "error", detail: err.message };
    }
    return { status: "error", detail: err instanceof Error ? err.message : "probe failed" };
  }
}
