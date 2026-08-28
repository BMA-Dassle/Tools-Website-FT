/**
 * Sign-in telemetry for the admin SSO gate — an in-memory ring buffer plus one
 * JSON line per event.
 *
 * WHY NOT pino HERE. `auth.ts` is reachable from server components and route
 * handlers, and the SSO log has to be readable from `/sso/diag` on a Node
 * runtime AND writable from the same module the (edge) middleware's siblings
 * import. pino is a Node library. So this module is a deliberately tiny
 * JSON-to-stdout shim — Vercel's runtime logs treat one JSON object per line
 * exactly the same whichever library wrote it. pino itself is used in
 * `app/sso/diag/route.ts`, which declares the Node runtime.
 *
 * WHY A RING BUFFER. `/sso/diag` has to be able to answer "why can't Dana sign
 * in?" without anyone opening the Vercel dashboard. Ten entries is enough to
 * see a pattern and small enough to be free. It is per-instance and lost on a
 * cold start — the durable copy is the gateway's audit log; this is the
 * consumer-side view of the same moment.
 *
 * Ported verbatim (bar the app name) from `apps/admin/src/sso-log.ts`, which
 * PR B retires along with the rest of the shell.
 */

export interface SsoErrorEntry {
  /** ISO instant. */
  at: string;
  /** Stable code the user was shown — SSO_E_NO_ROLE, SSO_E_CALLBACK_FAILED, … */
  code: string;
  /** The gateway's x-request-id, when the failure carried one. */
  requestId?: string;
  /** Who, when known. Never a token, never a secret. */
  email?: string;
  message?: string;
}

const RING_SIZE = 10;
const ring: SsoErrorEntry[] = [];

/** Stable error codes shown to users and echoed in diag. */
export const SSO_E = {
  /** Signed in fine, but holds no `access` role for this client. */
  NO_ROLE: "SSO_E_NO_ROLE",
  /** The gateway callback failed — bad state/nonce, token exchange, JWKS. */
  CALLBACK_FAILED: "SSO_E_CALLBACK_FAILED",
  /** The session expired mid-request (API callers see this as JSON). */
  EXPIRED: "SSO_E_SESSION_EXPIRED",
  /** The SSO env block is incomplete — a deploy problem, not a user problem. */
  CONFIG: "SSO_E_CONFIG",
  /** Anything Auth.js reported that we have no better name for. */
  UNKNOWN: "SSO_E_UNKNOWN",
} as const;

export function recordSsoError(entry: Omit<SsoErrorEntry, "at">): void {
  ring.push({ at: new Date().toISOString(), ...entry });
  while (ring.length > RING_SIZE) ring.shift();
  logSso("error", "sso.signin.failed", entry);
}

/** Newest first — the order a human reads them in. */
export function recentSsoErrors(): SsoErrorEntry[] {
  return [...ring].reverse();
}

/** Test seam: the buffer is module state, so suites must be able to reset it. */
export function resetSsoErrors(): void {
  ring.length = 0;
}

/** One JSON line. Never logs a token, a secret, or a cookie. */
export function logSso(
  level: "info" | "warn" | "error",
  event: string,
  detail?: Record<string, unknown>,
): void {
  const line = JSON.stringify({ level, event, app: "fasttrax-web", ...detail });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
