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
import type { VerifyResult } from "../types";

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

/**
 * Read a card's balance. Onsite first (real-time), cloud on ANY onsite failure —
 * a read cannot corrupt anything, so the fallback is unconditional.
 */
export async function verifyAccount(
  accountNumber: string,
  locationCode?: number,
): Promise<VerifyResult & { transport: IntercardTransport }> {
  if (onsiteFirst()) {
    try {
      const res = await onsite.verifyAccount(accountNumber, locationCode);
      // An ambiguous onsite answer is not authoritative — let the cloud copy
      // settle it rather than reporting a card as absent on thin evidence.
      if (!(res.exists === false && res.notFound === "ambiguous")) {
        return { ...res, transport: "onsite" };
      }
    } catch {
      // fall through to cloud
    }
  }
  const res = await cloud.verifyAccount(accountNumber, locationCode);
  return { ...res, transport: "cloud" };
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
