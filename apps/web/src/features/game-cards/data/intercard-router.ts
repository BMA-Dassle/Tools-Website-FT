/**
 * Intercard transport router — ONSITE FIRST, cloud SOAP as the fallback.
 *
 * Owner decision 2026-08-31: "onsite takes priority". The site's own
 * Transaction Server is the real-time truth (balances match the physical
 * readers the instant they change), so every call tries it first. The proven
 * SOAP path stays as the safety net for the one thing onsite cannot do:
 * survive a site outage.
 *
 * ┌───────────────┬──────────────────────────┬───────────────────────────────┐
 * │               │ onsite (Api_External)    │ cloud (SOAP, legacy)          │
 * ├───────────────┼──────────────────────────┼───────────────────────────────┤
 * │ truth         │ REAL-TIME site state     │ replicated datacenter copy    │
 * │ availability  │ needs the site relay up  │ up whenever Intercard is up   │
 * │ auth          │ 3 headers + MAC in body  │ MAC alone                     │
 * └───────────────┴──────────────────────────┴───────────────────────────────┘
 *
 * ⚠️ THE FALLBACK RULE IS ASYMMETRIC, AND DELIBERATELY SO:
 *
 *   READS  fall back freely. Re-reading a balance on the cloud copy is
 *          harmless — worst case it is slightly stale, which is exactly the
 *          behaviour we have today.
 *
 *   WRITES fall back ONLY when the onsite attempt is PROVABLY un-started.
 *          A relay timeout means the transaction may already be applied at the
 *          site; retrying it on the cloud path would DOUBLE-CREDIT the card.
 *          `RELAY_OFFLINE` (404) and `NO_TOKEN`/`NOT_LICENSED` are safe to fall
 *          back from because the relay never accepted the work — the request
 *          died at the licence gate or found no connected client. Anything
 *          else (RELAY_TIMEOUT, NETWORK mid-flight, HTTP 5xx) is AMBIGUOUS and
 *          must surface to the caller, which re-reads state before retrying.
 *          This mirrors the existing "never blind-retry money" rule.
 */

import { isOnsiteEnabled } from "~/config/intercard-centers";
import { IntercardError } from "./intercard";
import * as cloud from "./intercard";
import * as onsite from "./intercard-onsite";
import type { CardTxn, VerifyResult } from "../types";

/** Which transport served a call — for logging and the kiosk status chip. */
export type IntercardTransport = "onsite" | "cloud";

/**
 * Onsite failures that prove the write NEVER STARTED at the site, so retrying
 * it on the cloud path cannot double-apply. Everything else is ambiguous.
 */
const WRITE_SAFE_TO_FALL_BACK = new Set([
  "RELAY_OFFLINE", // 404 — no relay connected; the work was never dispatched
  "NOT_LICENSED", // 401 — rejected at the licence gate, before any dispatch
  "NO_TOKEN", // client-side: we never sent anything
  "NO_MAC", // client-side: we never sent anything
]);

function onsiteFirst(): boolean {
  return isOnsiteEnabled();
}

function isSafeWriteFallback(err: unknown): boolean {
  return err instanceof IntercardError && WRITE_SAFE_TO_FALL_BACK.has(err.code);
}

/** Same default the onsite/cloud clients use when no location is passed. */
const DEFAULT_LOC = 12;

/**
 * Onsite history that can never reject and never throw — `undefined` on any
 * failure, which callers must read as "could not check", not "there is none".
 * (blank-card.ts turns that distinction into a money decision.)
 */
async function onsiteHistoryOrUndefined(
  accountNumber: string,
  locationCode: number,
): Promise<CardTxn[] | undefined> {
  try {
    return await onsite.accountHistory(accountNumber, locationCode);
  } catch {
    return undefined;
  }
}

/**
 * Read a card's balance AND its recent on-card activity. Onsite first
 * (real-time), cloud on ANY onsite failure — a read cannot corrupt anything, so
 * the fallback is unconditional.
 *
 * ⚠️ THE HISTORY CALL IS NOT OPTIONAL. SOAP returned balance and transactions
 * from one operation; the onsite proxy splits them (`balanceinquiry` carries no
 * history at all). `onsite.verifyAccount` only does the balance half, so when
 * onsite became the default transport every caller's `transactions` silently
 * went `undefined` — measured 2026-09-01: 0 of 36 production reads carried any.
 * That empties the guest-facing activity lists, and it disarms half of
 * `classifySwipedCard`, which `assertSwipedBlanks` uses to refuse selling a
 * guest's own spent card back to them as a new one. So both halves are fetched
 * here, in parallel (same wall clock, one extra concurrent read).
 *
 * `transactions` stays `undefined` when the history call FAILED, and is `[]`
 * only when the service answered with nothing. Callers must not conflate the
 * two — see blank-card.ts.
 */
export async function verifyAccount(
  accountNumber: string,
  locationCode?: number,
): Promise<VerifyResult & { transport: IntercardTransport }> {
  if (onsiteFirst()) {
    // Started first so it runs alongside the balance call (same wall clock),
    // but fully isolated: the balance read is the critical path and must never
    // be downgraded to cloud just because history was unavailable. The wrapper
    // swallows synchronous throws too, so this can only ever resolve.
    const historyPromise = onsiteHistoryOrUndefined(accountNumber, locationCode ?? DEFAULT_LOC);
    try {
      const res = await onsite.verifyAccount(accountNumber, locationCode);
      // An ambiguous onsite answer is not authoritative — let the cloud copy
      // settle it rather than reporting a card as absent on thin evidence.
      if (!(res.exists === false && res.notFound === "ambiguous")) {
        const txns = res.exists ? await historyPromise : undefined;
        return {
          ...res,
          ...(txns ? { transactions: txns } : {}),
          transport: "onsite",
        };
      }
    } catch {
      // fall through to cloud
    }
  }
  const res = await cloud.verifyAccount(accountNumber, locationCode);
  return { ...res, transport: "cloud" };
}

/**
 * Balance read pinned to the ON-SITE server — NO cloud fallback, and it throws
 * rather than falling through when onsite cannot answer.
 *
 * This exists for exactly one caller: the post-credit readback in load-card.ts.
 * `verifyAccount` above falls to the cloud copy on any onsite failure, which is
 * right for a display lookup but WRONG as proof that a load landed. The floor's
 * redemption games read the on-site server; a credit that only reached the
 * divergent datacenter copy is money the guest can never spend. Confirming a
 * fresh load against cloud would call such a card "loaded" and hand over dead
 * plastic. So the load readback must interrogate the same server the games do,
 * and treat "onsite won't answer" as "not confirmed", never as "good".
 */
export async function verifyAccountOnsite(
  accountNumber: string,
  locationCode?: number,
): Promise<VerifyResult & { transport: IntercardTransport }> {
  const res = await onsite.verifyAccount(accountNumber, locationCode);
  return { ...res, transport: "onsite" };
}

/**
 * Credit tokens onto a card. Onsite first; cloud ONLY when the onsite attempt
 * provably never reached the site (see WRITE_SAFE_TO_FALL_BACK).
 */
export async function creditTokens(
  params: cloud.CreditTokensParams,
): Promise<{ code: number; transport: IntercardTransport }> {
  if (onsiteFirst()) {
    try {
      const res = await onsite.creditTokens(params);
      return { ...res, transport: "onsite" };
    } catch (err) {
      if (!isSafeWriteFallback(err)) throw err; // ambiguous — never double-credit
    }
  }
  const res = await cloud.creditTokens(params);
  return { ...res, transport: "cloud" };
}

/** Credit arbitrary values. Same asymmetric fallback rule as creditTokens. */
export async function creditAccountValues(
  params: cloud.CreditAccountValuesParams,
): Promise<{ code: number; transport: IntercardTransport }> {
  if (onsiteFirst()) {
    try {
      const res = await onsite.creditAccountValues(params);
      return { ...res, transport: "onsite" };
    } catch (err) {
      if (!isSafeWriteFallback(err)) throw err;
    }
  }
  const res = await cloud.creditAccountValues(params);
  return { ...res, transport: "cloud" };
}

/**
 * Clear accounts. Note the onsite client needs an idempotency id the SOAP one
 * does not take — callers already hold a stable id for the surrounding
 * operation, so it is threaded through rather than invented here.
 */
export async function clearAccount(
  params: cloud.ClearAccountParams & { tpiTransactionID: string },
): Promise<{ code: number; transport: IntercardTransport }> {
  if (onsiteFirst()) {
    try {
      const res = await onsite.clearAccount(params);
      return { ...res, transport: "onsite" };
    } catch (err) {
      if (!isSafeWriteFallback(err)) throw err;
    }
  }
  const res = await cloud.clearAccount({
    locationCode: params.locationCode,
    accountNumbers: params.accountNumbers,
  });
  return { ...res, transport: "cloud" };
}

/** Consolidate cards. Same asymmetric fallback rule. */
export async function consolidateAccounts(
  params: cloud.ConsolidateAccountsParams,
): Promise<{ code: number; transport: IntercardTransport }> {
  if (onsiteFirst()) {
    try {
      const res = await onsite.consolidateAccounts(params);
      return { ...res, transport: "onsite" };
    } catch (err) {
      if (!isSafeWriteFallback(err)) throw err;
    }
  }
  const res = await cloud.consolidateAccounts(params);
  return { ...res, transport: "cloud" };
}

export { IntercardError };
