/**
 * PassKit REST transport — Apple/Google Wallet passes. TRANSPORT ONLY: auth,
 * one fetch helper, and typed errors. No voucher knowledge lives here (that's
 * `features/game-cards/wallet/voucher-pass.ts`), because the racing-licence
 * pass will ride the same client.
 *
 * ── Three things that are not guessable, all measured live 2026-08-03 ────────
 *
 * REGION. Our account is `pub2` (USA). Every PassKit doc example says `pub1`,
 * which authenticates fine and then 404s on every object.
 *
 * JWT. HS256 over `{uid, iat, exp}`, and the header is `Authorization: <jwt>`
 * with **no `Bearer` prefix**. `iat` MUST BE BACKDATED: at `iat = now` the API
 * returns 401 `Token used before issued` (their clock ran ~3 s behind ours),
 * and older than ~60 s returns `jwt was issued too long ago`. Measured good
 * window: −5 s … −60 s, so we sit at −30 s. `exp` must be ≤ 60 s out, which is
 * why every request signs its own token — there is nothing worth caching.
 *
 * PROTO ERRORS LIE ABOUT THE CAUSE. PassKit parses bodies with protojson, and a
 * field of the wrong SHAPE surfaces as `proto: syntax error … unexpected token`
 * pointing at the value, not as a field error. The one that cost us: a project
 * `status` is a REPEATED bitmask, so a scalar string looks like a syntax error
 * rather than "expected array". If you see a syntax error, suspect shape.
 */

const REGION_BASE = "https://api.pub2.passkit.io";

/** How far back to date `iat`. Inside the measured −5 s … −60 s window. */
const IAT_BACKDATE_SECONDS = 30;
/** Must be ≤ 60 s in the future or the token is rejected outright. */
const EXP_SECONDS = 50;

export class PassKitError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    method: string,
    path: string,
  ) {
    super(`PassKit ${method} ${path} → ${status} ${body.slice(0, 300)}`);
    this.name = "PassKitError";
  }

  /** A duplicate `externalId` in the same campaign. Not a failure — it means
   *  the pass already exists and the caller should recover it by externalId. */
  get isDuplicate(): boolean {
    return this.status === 409;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export function isPassKitConfigured(): boolean {
  return !!process.env.PASSKIT_API_KEY && !!process.env.PASSKIT_API_SECRET;
}

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A fresh short-lived JWT. Never cache one — `exp` is capped at ~60 s. */
async function signJwt(): Promise<string> {
  const key = process.env.PASSKIT_API_KEY;
  const secret = process.env.PASSKIT_API_SECRET;
  if (!key || !secret) throw new Error("PassKit: PASSKIT_API_KEY / PASSKIT_API_SECRET not set");

  const { createHmac } = await import("crypto");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url({ uid: key, iat: now - IAT_BACKDATE_SECONDS, exp: now + EXP_SECONDS });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * One PassKit call. Throws `PassKitError` on any non-2xx so callers can branch
 * on `isDuplicate` / `isNotFound` instead of string-matching bodies.
 */
export async function passkit<T = unknown>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const base = process.env.PASSKIT_API_URL || REGION_BASE;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: await signJwt(),
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    // PassKit is a sync mirror, never on a guest's critical path. Fail fast
    // rather than hold a request open.
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new PassKitError(res.status, text, method, path);
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Streamed list endpoints return newline-delimited JSON, which no caller
    // here needs — surface the raw text rather than pretend it parsed.
    return { raw: text } as T;
  }
}

/** Wallet links for an issued pass. `.pkpass` / `.gpay` skip PassKit's own
 *  landing page, which is one fewer tap on the platforms that matter. */
export function passUrls(passId: string): { apple: string; google: string; landing: string } {
  const host = (process.env.PASSKIT_API_URL || REGION_BASE).includes("pub1")
    ? "https://pub1.pskt.io"
    : "https://pub2.pskt.io";
  return {
    apple: `${host}/${passId}.pkpass`,
    google: `${host}/${passId}.gpay`,
    landing: `${host}/${passId}`,
  };
}
