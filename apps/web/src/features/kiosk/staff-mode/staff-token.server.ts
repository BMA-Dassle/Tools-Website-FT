import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { StaffEmployee } from "./types";

/**
 * The STAFF TOKEN — what a kiosk holds after a staff card resolves, and what
 * the actions route demands back on every write.
 *
 * WHY A TOKEN AND NOT THE PIN. The floor PIN is anonymous; a staff action must
 * name WHO did it (the Neon log is the point). So /api/kiosk/staff-card mints a
 * short-lived credential that CARRIES the employee, signed, and the actions
 * route reads the employee out of the token — never from the request body a
 * client could edit.
 *
 * FORMAT `<expMs>.<base64url(JSON employee)>.<hex HMAC-SHA256(secret, expMs + "." + payload)>`
 * Same family as lib/admin-api-token.ts (expiry IS part of the signed message,
 * so it cannot be moved), with a payload segment added. Header-safe.
 *
 * TTL. The UI hides after 10 s idle; the token lives 15 minutes so a sheet the
 * staff member is mid-way through never dies under them, and so a re-scan is
 * not needed for a second action a minute later. A leaked token is worth one
 * kiosk's staff actions for a quarter of an hour, all of them logged.
 *
 * SECRET. `KIOSK_STAFF_SIGNING_SECRET` when set; else the admin signing secret
 * / ADMIN_CAMERA_TOKEN fallback the admin token already uses — every deployable
 * environment has one, so this ships without a new env var. No secret → no
 * tokens (fail closed).
 */

export const STAFF_TOKEN_TTL_MS = 15 * 60 * 1000;

function signingSecret(): string {
  return (
    process.env.KIOSK_STAFF_SIGNING_SECRET ||
    process.env.ADMIN_API_SIGNING_SECRET ||
    process.env.ADMIN_CAMERA_TOKEN ||
    ""
  );
}

function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function fromB64url(s: string): string | null {
  try {
    return Buffer.from(s, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

/** "" when no secret is configured — the caller answers "staff mode unavailable". */
export function mintStaffToken(
  employee: StaffEmployee,
  ttlMs: number = STAFF_TOKEN_TTL_MS,
  now: number = Date.now(),
): string {
  const secret = signingSecret();
  if (!secret) return "";
  const exp = now + Math.max(0, ttlMs);
  const payload = b64url(JSON.stringify(employee));
  return `${exp}.${payload}.${hmacHex(secret, `${exp}.${payload}`)}`;
}

/** The employee inside a well-formed, unexpired, correctly signed token — else null. */
export function verifyStaffToken(
  value: string | null | undefined,
  now: number = Date.now(),
): StaffEmployee | null {
  const secret = signingSecret();
  if (!secret || !value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [expPart, payload, sig] = parts;
  if (!/^\d{1,15}$/.test(expPart) || !payload || !sig) return null;
  if (Number(expPart) <= now) return null;
  const expected = hmacHex(secret, `${expPart}.${payload}`);
  if (expected.length !== sig.length) return null;
  if (!timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(sig, "utf8"))) return null;
  const json = fromB64url(payload);
  if (!json) return null;
  try {
    const e = JSON.parse(json) as Partial<StaffEmployee>;
    if (typeof e.id !== "string" || typeof e.name !== "string" || typeof e.cardTail !== "string") {
      return null;
    }
    return {
      id: e.id,
      name: e.name,
      cardTail: e.cardTail,
      ...(typeof e.role === "string" ? { role: e.role } : {}),
    };
  } catch {
    return null;
  }
}
