/**
 * Groupon partner request signing — pure, no network, no env.
 *
 * Groupon's partner Offer API does NOT take a bearer key. Every request carries
 * an HMAC-SHA1 signature over a canonical base string, plus the client id in
 * its own header. Spec:
 * https://www.groupon.com/developers/1-integration-technical-setup-2
 *
 *   base = VERB & PE(nonce) & PE(baseUrlNoQuery) & PE(paramString) & sha256hex(body)
 *   sig  = PE(BASE64(HMAC_SHA1(signingKey, base)))
 *
 * Three details cost real time to discover (2026-08-18) and are pinned by tests:
 *
 *  1. The signing key is used RAW. It looks like base64 (88 chars) and is not —
 *     decoding it produces a signature Groupon rejects.
 *  2. `paramString` is percent-encoded TWICE. Each key and value is encoded
 *     when the pairs are built, then the whole joined string is encoded again
 *     as one component of the base string. A value containing `+` or `=` is
 *     the only place this shows up, so a fixture without one proves nothing.
 *  3. The body hash is plain hex and is NOT percent-encoded, unlike every
 *     other component.
 *
 * The error ladder, when a signature is wrong, is worth knowing: a bad/absent
 * client id fails first with `'client_id' is invalid`, and only once the client
 * id is accepted do you see `INVALID_REQUEST_SIGNATURE`. Reaching the second
 * error means the credentials are fine and only the base string is wrong.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * RFC 3986 percent-encoding. `encodeURIComponent` leaves `!*'()` alone but
 * RFC 3986 reserves them, and Groupon canonicalises per RFC 3986 — so a code
 * or query value containing one would otherwise sign differently than it is
 * sent, and 401.
 */
export function percentEncode(value: string | number): string {
  return encodeURIComponent(String(value)).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Query params canonicalised: sorted by key, each part encoded, joined `k=v`. */
export function canonicalParamString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
}

/** The exact query string to put on the wire. MUST match what was signed. */
export function queryString(params: Record<string, string>): string {
  return canonicalParamString(params);
}

/** SHA-256 hex of the (trimmed) request body. Empty body has a fixed digest. */
export function bodyHash(body: string): string {
  return createHash("sha256").update(body.trim(), "utf8").digest("hex");
}

export interface SignatureInput {
  method: string;
  /** Absolute URL WITHOUT the query string. */
  baseUrl: string;
  params?: Record<string, string>;
  /** Serialized request body, or "" for none. */
  body?: string;
  signingKey: string;
  /** Injectable so tests are deterministic; production generates one per call. */
  nonce?: string;
}

export interface SignedRequest {
  authorization: string;
  nonce: string;
  /** Exposed for diagnostics — a 401 is almost always a base-string bug. */
  baseString: string;
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

export function signRequest(input: SignatureInput): SignedRequest {
  const nonce = input.nonce ?? newNonce();
  const baseString = [
    input.method.toUpperCase(),
    percentEncode(nonce),
    percentEncode(input.baseUrl),
    percentEncode(canonicalParamString(input.params ?? {})),
    bodyHash(input.body ?? ""),
  ].join("&");

  const signature = percentEncode(
    createHmac("sha1", input.signingKey).update(baseString, "utf8").digest("base64"),
  );

  return {
    authorization: `groupon-third-party version="1.1",digest="HMAC-SHA1",nonce="${nonce}",signature="${signature}"`,
    nonce,
    baseString,
  };
}
