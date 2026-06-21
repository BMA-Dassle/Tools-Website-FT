import { cookies } from "next/headers";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { CSRF_HEADER, SESSION_ABSOLUTE_TTL_MS, SESSION_COOKIE } from "../constants";
import { AccountHttpError } from "../errors";
import {
  deleteSessionRecord,
  newSid,
  readSessionRecord,
  slideSession,
  writeSession,
} from "../data/session-store";
import type { AccountSession, ContactType, SessionRecord } from "../types";

const SECRET = process.env.ACCOUNT_SESSION_SECRET || "";

/** Cookie value = `{sid}.{HMAC(sid)}` — Next doesn't sign cookies, so we do. */
function sign(sid: string): string {
  const mac = createHmac("sha256", SECRET).update(sid).digest("base64url");
  return `${sid}.${mac}`;
}

/** Verify the HMAC (timing-safe) BEFORE any Redis lookup; returns sid or null. */
function unsign(token: string): string | null {
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  const sid = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = createHmac("sha256", SECRET).update(sid).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length === 0 || a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? sid : null;
}

const cookieOpts = (maxAge: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge,
});

/**
 * Mint a fresh session after a verified OTP. A NEW sid every time defeats
 * session fixation. Must be called inside a Route Handler (sets a cookie).
 */
export async function mintSession(params: {
  contact: string;
  contactType: ContactType;
  squareCustomerIds: string[];
}): Promise<AccountSession> {
  if (!SECRET) throw new AccountHttpError(500, "CONFIG", "ACCOUNT_SESSION_SECRET not configured");
  const sid = newSid();
  const now = Date.now();
  const record: SessionRecord = {
    contact: params.contact,
    contactType: params.contactType,
    squareCustomerIds: params.squareCustomerIds,
    csrf: randomBytes(18).toString("base64url"),
    createdAt: now,
    exp: now + SESSION_ABSOLUTE_TTL_MS,
  };
  await writeSession(sid, record);
  const store = await cookies();
  store.set(SESSION_COOKIE, sign(sid), cookieOpts(Math.floor(SESSION_ABSOLUTE_TTL_MS / 1000)));
  return { sid, ...record };
}

/** Load + validate the current session (or null). Slides idle expiry. */
export async function getSession(): Promise<AccountSession | null> {
  if (!SECRET) return null;
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const sid = unsign(token);
  if (!sid) return null;
  const record = await readSessionRecord(sid);
  if (!record) return null;
  if (Date.now() > record.exp) {
    await deleteSessionRecord(sid);
    return null;
  }
  await slideSession(sid);
  return { sid, ...record };
}

export async function requireSession(): Promise<AccountSession> {
  const s = await getSession();
  if (!s) throw new AccountHttpError(401, "SESSION_EXPIRED", "Please log in again");
  return s;
}

/** Double-submit CSRF check for mutations. GETs are exempt. */
export function requireCsrf(session: AccountSession, req: Request): void {
  const provided = req.headers.get(CSRF_HEADER) || "";
  const a = Buffer.from(provided);
  const b = Buffer.from(session.csrf);
  if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AccountHttpError(403, "CSRF", "Invalid request token");
  }
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    const sid = unsign(token);
    if (sid) await deleteSessionRecord(sid);
  }
  store.set(SESSION_COOKIE, "", cookieOpts(0));
}
