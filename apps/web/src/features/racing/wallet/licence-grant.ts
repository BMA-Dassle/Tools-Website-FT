/**
 * Proof that THIS browser just put a waiver on file for THIS person.
 *
 * WHY A TOKEN AND NOT A LIST OF IDS. Every licence surface so far hangs off a
 * booking: `/api/racing/licence-offer?billId=…` answers "who is on this
 * booking", and the add hop re-checks that the personId is actually on it. That
 * check is what stops the endpoint being a person-lookup oracle — hand it any
 * id you like and it will not resolve a stranger's login code, because a login
 * code is that racer's identity at the kiosk, the check-in desk and the BMI
 * register.
 *
 * A waiver has no booking. The standalone flow is often the FIRST thing a guest
 * ever does with us, and the group-events participant link is deliberately
 * reservation-less for anyone who arrives on a forwarded URL. So there is
 * nothing to check a personId against — and an endpoint that simply believed a
 * client-supplied list would resolve any person's licence for anyone who could
 * guess a 17-digit id. BMI ids are sequential.
 *
 * So the proof is minted where a signature ACTUALLY SUCCEEDS: `POST
 * /api/pandora/waiver`, after Pandora has accepted the signature (or told us
 * the person's existing waiver is still valid). Forging one of these means
 * signing that person's waiver, which is the bar we want.
 *
 * WHAT IT IS NOT. Not a session, not a login, not a substitute for the login
 * code. It says one thing — "a waiver for person P went on file here at time T"
 * — and it stops saying it two hours later.
 */
import { createHmac, timingSafeEqual } from "crypto";

/** Same chain the confirmation links have always used, so no new secret has to
 *  be provisioned before this works in production. */
const SECRET =
  process.env.BOOKING_HMAC_SECRET || process.env.SENDGRID_API_KEY || "fasttrax-booking-secret";

/** Long enough to finish signing for a family and add the passes; short enough
 *  that a grant left in a browser history is dead by the next visit. */
const TTL_SECONDS = 2 * 60 * 60;

/** Separator between grants in a query string. Not a comma: a comma is
 *  form-encoded inconsistently by enough clients to be worth avoiding, and `~`
 *  is unreserved in a URL so it survives an encode/decode round trip intact. */
export const GRANT_SEPARATOR = "~";

export interface LicenceGrant {
  personId: string;
  /** Display name, carried so the offer endpoint needs no extra lookup to
   *  label a row — and SIGNED, so a client cannot relabel someone else's row. */
  name: string;
}

interface GrantPayload {
  p: string;
  n: string;
  e: number;
}

function mac(body: string): string {
  return createHmac("sha256", SECRET).update(`licence-grant:${body}`).digest("base64url");
}

/**
 * Mint a grant. Call ONLY on a path where the waiver is genuinely on file —
 * minting one anywhere a client can reach with an arbitrary personId would
 * rebuild the oracle this exists to prevent.
 */
export function signLicenceGrant(personId: string, name: string, nowMs = Date.now()): string {
  const payload: GrantPayload = {
    p: String(personId).trim(),
    // Bounded: the name is echoed into a page, and an unbounded one signed by us
    // is a stored-XSS payload we vouched for.
    n: String(name ?? "").trim().slice(0, 60),
    e: Math.floor(nowMs / 1000) + TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body)}`;
}

/** One grant → the person it vouches for, or null if it is forged, malformed,
 *  or expired. Never throws: a junk query param is a `null`, not a 500. */
export function verifyLicenceGrant(token: string, nowMs = Date.now()): LicenceGrant | null {
  const raw = String(token ?? "").trim();
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = mac(body);

  // Constant time, and length-checked first — timingSafeEqual THROWS on a
  // length mismatch, which would turn a malformed token into a 500.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: GrantPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!payload || !/^\d+$/.test(String(payload.p ?? ""))) return null;
  if (!Number.isFinite(payload.e) || payload.e * 1000 <= nowMs) return null;

  return { personId: String(payload.p), name: String(payload.n ?? "").trim() };
}

/**
 * A whole party's grants from one query parameter, deduped by person and
 * capped. Invalid ones are DROPPED rather than failing the batch: one expired
 * grant in a family of four must not cost the other three their passes.
 */
export function verifyLicenceGrants(param: string | null, nowMs = Date.now()): LicenceGrant[] {
  if (!param) return [];
  const out: LicenceGrant[] = [];
  const seen = new Set<string>();
  for (const token of param.split(GRANT_SEPARATOR).slice(0, 12)) {
    const grant = verifyLicenceGrant(token, nowMs);
    if (!grant || seen.has(grant.personId)) continue;
    seen.add(grant.personId);
    out.push(grant);
  }
  return out;
}
