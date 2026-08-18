/**
 * Groupon partner Offer API client — SERVER ONLY.
 *
 * `.server.ts` is load-bearing: the signing key must never reach a kiosk
 * bundle. `next build` fails a client import of this module, which is the gate
 * we rely on.
 *
 * Two things here are NOT what Groupon's published OpenAPI says, both learned
 * the hard way against staging on 2026-08-18. Do not "fix" them back:
 *
 *  1. The public spec (groupon-simulator/get-open-api-spec) is the Connect
 *     BOOKINGS contract. It does not even contain the GET we use. Our funnel is
 *     POS / redemption-only — no booking, no reserve — so the spec's PATCH body
 *     (`{id, status, updatedAt}`, where `id` is "returned from the Reserve API
 *     call") describes a call we never make.
 *  2. Redeeming therefore does NOT work by id. Every identifier we have
 *     (unit id, redemptionCode, grouponCode) returns UNIT_NOT_FOUND when sent
 *     that way. What works is echoing the WHOLE unit object from the GET back
 *     with `status: "redeemed"`. Hence `redeemUnit` takes a unit, not an id —
 *     the type makes the fetch-then-echo order impossible to get wrong.
 *
 * Environment: the HOST IS THE SAME for staging and production. The environment
 * is the CONFIG NAME in the path (`headpinz-preprod` vs `headpinz`);
 * `offer-api-staging.groupon.com` rejects our client id outright.
 */

import { signRequest, queryString } from "./sign";
import type { GrouponUnit, GrouponErrorCode } from "./types";

const HOST = "https://offer-api.groupon.com";

/** Identifies the integration to Groupon. Not a browser, not a generic script. */
const USER_AGENT = "HeadPinz-POS/1.0";

/**
 * Credentials live here and ONLY here. `@ft/env` does not exist yet (PR4 of the
 * restructure); keeping every read in one module makes that migration a
 * one-file change instead of a hunt.
 */
function credentials(): { clientId: string; apiKey: string; config: string } {
  const clientId = process.env.GROUPON_CLIENT_ID ?? "";
  const apiKey = process.env.GROUPON_API_KEY ?? "";
  const config = process.env.GROUPON_CONFIG_NAME ?? "";
  if (!clientId || !apiKey || !config) {
    throw new Error(
      "groupon: GROUPON_CLIENT_ID, GROUPON_API_KEY and GROUPON_CONFIG_NAME must all be set",
    );
  }
  return { clientId, apiKey, config };
}

export function isGrouponConfigured(): boolean {
  return !!(
    process.env.GROUPON_CLIENT_ID &&
    process.env.GROUPON_API_KEY &&
    process.env.GROUPON_CONFIG_NAME
  );
}

export interface GrouponResponse<T> {
  status: number;
  ok: boolean;
  data: T | null;
  errorCodes: GrouponErrorCode[];
  /** Raw body, kept for the ledger's `last_error` so failures stay diagnosable. */
  raw: string;
}

/**
 * Retry ONLY what Groupon says is transient. Staging returns intermittent
 * `400 UNKNOWN_ERROR` on reads that succeed moments later (one code failed
 * three times then succeeded), and Groupon's own docs instruct partners to
 * retry that code.
 *
 * UNIT_NOT_FOUND, MALFORMED_REQUEST and INVALID_STATE_TRANSITION are terminal
 * verdicts about this request — retrying them burns time and, on a redeem,
 * hammers a voucher that already has an answer.
 */
export function isRetryable(status: number, codes: GrouponErrorCode[]): boolean {
  if (status >= 500) return true;
  if (status === 429) return true;
  return status === 400 && codes.includes("UNKNOWN_ERROR");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(
  method: "GET" | "PATCH",
  params: Record<string, string>,
  bodyObj: unknown | null,
  { tries = 4 }: { tries?: number } = {},
): Promise<GrouponResponse<T>> {
  const { clientId, apiKey, config } = credentials();
  const baseUrl = `${HOST}/partners/${config}/v1/units`;
  const body = bodyObj === null ? "" : JSON.stringify(bodyObj);

  let last: GrouponResponse<T> | null = null;

  for (let attempt = 0; attempt < tries; attempt++) {
    // A fresh nonce per ATTEMPT, not per call — a replayed nonce is a
    // different request as far as Groupon is concerned.
    const { authorization } = signRequest({
      method,
      baseUrl,
      params,
      body,
      signingKey: apiKey,
    });

    const qs = queryString(params);
    const res = await fetch(qs ? `${baseUrl}?${qs}` : baseUrl, {
      method,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        Authorization: authorization,
        "x-client-id": clientId,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
      cache: "no-store",
    });

    const raw = await res.text();
    // Named, not `typeof parsed` — that self-reference narrows to `null` at the
    // cast and poisons every read below with `never`.
    type Envelope = { data?: T; errors?: { code?: string }[] };
    let parsed: Envelope | null = null;
    try {
      parsed = JSON.parse(raw) as Envelope;
    } catch {
      parsed = null;
    }

    const errorCodes = (parsed?.errors ?? [])
      .map((e) => e?.code)
      .filter((c): c is GrouponErrorCode => typeof c === "string" && c.length > 0);

    last = {
      status: res.status,
      ok: res.ok,
      data: parsed?.data ?? null,
      errorCodes,
      raw,
    };

    if (!isRetryable(res.status, errorCodes)) return last;
    if (attempt < tries - 1) await sleep(500 * (attempt + 1));
  }

  return last as GrouponResponse<T>;
}

/**
 * Look a voucher up. NON-DESTRUCTIVE — safe to call on every scan.
 *
 * ONE CODE PER CALL. A comma-joined `redemptionCodes` list breaks Groupon's
 * canonicalisation and 401s with INVALID_REQUEST_SIGNATURE, so the plural
 * parameter name is a lie we do not act on.
 */
export async function fetchUnit(code: string): Promise<GrouponResponse<GrouponUnit[]>> {
  return call<GrouponUnit[]>("GET", { redemptionCodes: code }, null);
}

/**
 * Mark a voucher redeemed. DESTRUCTIVE and irreversible.
 *
 * Pass the unit exactly as `fetchUnit` returned it. Groupon refuses a second
 * redeem with INVALID_STATE_TRANSITION, so a double-fire is safe — but that is
 * a backstop, not our concurrency control: the per-item claim CAS is.
 *
 * `client_id` is a QUERY parameter here (not just the header), so it is part of
 * the signed param string.
 */
export async function redeemUnit(unit: GrouponUnit): Promise<GrouponResponse<GrouponUnit[]>> {
  const { clientId } = credentials();
  const now = new Date().toISOString();
  const body = {
    data: [{ ...unit, status: "redeemed", redeemedAt: now, updatedAt: now }],
  };
  // tries:1 — a redeem is not idempotent on OUR side of the ledger. The queue
  // owns retrying, so a failure is recorded and driven forward deliberately
  // rather than hammered inside one request.
  return call<GrouponUnit[]>("PATCH", { client_id: clientId }, body, { tries: 1 });
}
