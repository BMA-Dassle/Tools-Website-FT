/**
 * Short-lived, signed admin API credential — the thing a staff browser is
 * allowed to hold instead of ADMIN_CAMERA_TOKEN.
 *
 * WHY. Every `/admin/{token}/*` page server component used to hand the raw
 * static token to its client component, which sent it back as `x-admin-token`
 * / `?token=`. That put a permanent, un-rotatable bearer secret into ~20
 * browser bundles, into devtools, into screenshots, and into anything a staff
 * member pasted. The token is the ONLY credential the admin gate has, so a
 * single leak is total: it opens every admin page and every admin API on both
 * brand domains, forever.
 *
 * The fix: pages mint a token that expires. It carries no secret — just an
 * expiry and an HMAC of that expiry — so a leaked one is worthless in 8 hours
 * and cannot be replayed with a different expiry. It authenticates
 * `/api/admin/*` only; it is NOT a page credential (the shell's proxy key and
 * the static token stay the page credentials — see middleware.ts).
 *
 * FORMAT: `<expMs>.<hex HMAC-SHA256(secret, String(expMs))>` — one field, safe
 * in a header and in a query string, no base64/JSON to mis-parse.
 *
 * WEB CRYPTO ONLY, on purpose: `verifyAdminApiToken` runs inside the EDGE
 * middleware, where `node:crypto` does not exist. That makes both functions
 * async; every caller is already an async server component or an async
 * middleware.
 *
 * SERVER-ONLY. Nothing in this module may be imported from a `"use client"`
 * module — it reads the signing secret from env. `scripts/check-admin-token-leak.mjs`
 * pins that. (No `import "server-only"`: the middleware imports this file and
 * the edge runtime has no `react-server` condition to satisfy that guard.)
 */

/** 8 hours — a full front-desk shift, so a board opened at clock-in still
 *  works at clock-out without a reload. */
export const ADMIN_API_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * The HMAC key. `ADMIN_API_SIGNING_SECRET` when set; otherwise the existing
 * `ADMIN_CAMERA_TOKEN`.
 *
 * The fallback is deliberate and is what makes this shippable without a
 * deploy-blocking env change: every environment that can serve an admin page
 * today already has ADMIN_CAMERA_TOKEN, so minting works on day one and no
 * board breaks waiting for a new Vercel variable. The token is a server-side
 * secret and an HMAC never reveals its key, so using it as one leaks nothing —
 * and once `ADMIN_API_SIGNING_SECRET` is set (PR 2 / rotation) the signing key
 * and the bearer token become independent.
 */
function signingSecret(): string {
  return process.env.ADMIN_API_SIGNING_SECRET || process.env.ADMIN_CAMERA_TOKEN || "";
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  let out = "";
  for (const b of sig) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Length-independent comparison — never `===` on a credential. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/**
 * Mint a credential valid for `ttlMs` from now.
 *
 * Returns `""` when no signing secret is configured — the same fail-closed
 * shape the rest of the admin gate uses. A caller that gets `""` hands its
 * client an empty token and the API answers 404, which is correct: an
 * environment with no admin secret has no admin.
 */
export async function mintAdminApiToken(ttlMs: number = ADMIN_API_TOKEN_TTL_MS): Promise<string> {
  const secret = signingSecret();
  if (!secret) return "";
  const expMs = Date.now() + Math.max(0, ttlMs);
  return `${expMs}.${await hmacHex(secret, String(expMs))}`;
}

/**
 * True when `value` is a well-formed, unexpired, correctly signed token.
 *
 * False for everything else — unset secret, wrong shape, non-numeric expiry,
 * expired, tampered signature, tampered expiry (the expiry IS the signed
 * message, so moving it invalidates the MAC).
 */
export async function verifyAdminApiToken(value: string | null | undefined): Promise<boolean> {
  const secret = signingSecret();
  if (!secret || !value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return false;
  const expPart = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^\d{1,15}$/.test(expPart)) return false;
  if (Number(expPart) <= Date.now()) return false;
  return timingSafeEqual(sig, await hmacHex(secret, expPart));
}
