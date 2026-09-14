import "server-only";

/**
 * Employee perks — the SERVER half: the one credential and the one check.
 *
 *   1. `startEmployeeVerification`  punch ID or mobile → ONE active 7shifts user
 *      → a 6-digit code texted to the mobile 7SHIFTS holds (never a number the
 *      person typed) → a short-lived signed CHALLENGE naming the user.
 *   2. `verifyEmployeeCode`          challenge + code → the EMPLOYEE TOKEN
 *      (HMAC, ~45 min), plus the BMI link when the party — or a BMI search by
 *      last name + birth date — yields exactly one person passing the name rule.
 *   3. `recognizeEmployee`           a lookup-sourced BMI person who already has
 *      a live link → the same token with no new code, if 7shifts still lists
 *      them active and the record still passes the rule.
 *   4. `applyEmployeeToSession`      what EVERY price rail calls first: strip the
 *      client's perk stamps, verify the token, re-check active, re-stamp the one
 *      member. The client's fields are display hints; this is the truth.
 *
 * Neutral failures: an unknown ID, a mobile not on the roster and a wrong code
 * all read as "we couldn't verify you" — no enumeration oracle for who is staff.
 *
 * Kill switch only: `EMPLOYEE_PERKS !== "false"` (default ON). Off ⇒ no codes
 * are sent and no token verifies, which turns every perk off everywhere at once.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { voxSend } from "@/lib/sms-retry";
import { consumeOtp, generateCode, reserveSend, storeOtp } from "~/features/account/data/otp-store";
import { maskValue } from "~/features/account/contact";
import { getStaffRecord, resolveEmployee } from "~/features/staff/service";
import type { StaffRecord } from "~/features/staff/punch-index";
import { lookupLicenseMatches } from "~/features/kiosk/license/lookup.server";
import { clientKeyForLookup } from "~/features/kiosk/license/lookup.server";
import type { LicenseMatch } from "~/features/kiosk/license/types";
import {
  matchEmployeeToParty,
  normalizeNameToken,
  payWeekKey,
  stampEmployeeOnParty,
  type MatchablePerson,
  type SessionEmployee,
} from "./employee";
import {
  countFreeRacesUsed,
  getEmployeeLinkForPerson,
  touchEmployeeLink,
  upsertEmployeeLink,
} from "./employee-data";

export const EMPLOYEE_TOKEN_TTL_MS = 45 * 60 * 1000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export function employeePerksEnabled(): boolean {
  return process.env.EMPLOYEE_PERKS !== "false";
}

function signingSecret(): string {
  return (
    process.env.EMPLOYEE_PERKS_SIGNING_SECRET ||
    process.env.KIOSK_STAFF_SIGNING_SECRET ||
    process.env.ADMIN_API_SIGNING_SECRET ||
    process.env.ADMIN_CAMERA_TOKEN ||
    ""
  );
}

// ── Signed payloads (same family as kiosk staff-token / admin-api-token) ─────

function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

function sign(kind: string, payload: object, ttlMs: number, now = Date.now()): string {
  const secret = signingSecret();
  if (!secret) return "";
  const exp = now + Math.max(0, ttlMs);
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${kind}.${exp}.${body}.${hmacHex(secret, `${kind}.${exp}.${body}`)}`;
}

function open<T>(kind: string, value: string | null | undefined, now = Date.now()): T | null {
  const secret = signingSecret();
  if (!secret || !value) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [k, expPart, body, sig] = parts;
  if (k !== kind || !/^\d{1,15}$/.test(expPart) || !body || !sig) return null;
  if (Number(expPart) <= now) return null;
  const expected = hmacHex(secret, `${k}.${expPart}.${body}`);
  if (expected.length !== sig.length) return null;
  if (!timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(sig, "utf8"))) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** What the employee token carries. `memberId` binds it to one party entry. */
export interface EmployeeTokenPayload {
  userId: number;
  firstName: string;
  memberId: string | null;
  bmiPersonId: string | null;
}

export function mintEmployeeToken(p: EmployeeTokenPayload, now = Date.now()): string {
  return sign("emp", p, EMPLOYEE_TOKEN_TTL_MS, now);
}

export function verifyEmployeeToken(value: string | null | undefined, now = Date.now()) {
  const p = open<Partial<EmployeeTokenPayload>>("emp", value, now);
  if (!p || typeof p.userId !== "number" || typeof p.firstName !== "string") return null;
  return {
    userId: p.userId,
    firstName: p.firstName,
    memberId: typeof p.memberId === "string" ? p.memberId : null,
    bmiPersonId: typeof p.bmiPersonId === "string" ? p.bmiPersonId : null,
  } satisfies EmployeeTokenPayload;
}

// ── 1. Start: identify + text the code ────────────────────────────────────────

export type StartResult =
  | { ok: true; challenge: string; maskedPhone: string }
  /** Unknown / ambiguous / wrong shape — ONE neutral answer. */
  | { ok: false; reason: "unverified" }
  /** A real employee whose 7shifts profile has no usable mobile. Only reachable
   *  AFTER a valid punch ID, so it is safe to be specific. */
  | { ok: false; reason: "no-mobile" }
  | { ok: false; reason: "rate-limited"; retryAfterSec: number }
  | { ok: false; reason: "unavailable" }
  | { ok: false; reason: "disabled" };

export async function startEmployeeVerification(input: {
  punchId?: string | null;
  phone?: string | null;
  /** Per-IP cap key (web) or the kiosk device key. */
  limiterKey: string;
  brand?: "fasttrax" | "headpinz";
}): Promise<StartResult> {
  if (!employeePerksEnabled()) return { ok: false, reason: "disabled" };
  const res = await resolveEmployee({ punchId: input.punchId, phone: input.phone });
  if (!res.ok) {
    return { ok: false, reason: res.reason === "unavailable" ? "unavailable" : "unverified" };
  }
  const staff = res.staff;
  if (!staff.mobile) return { ok: false, reason: "no-mobile" };

  const key = `emp:${staff.userId}`;
  const reserve = await reserveSend(key, input.limiterKey);
  if (reserve.blocked)
    return { ok: false, reason: "rate-limited", retryAfterSec: reserve.retryAfterSec };

  const code = generateCode();
  await storeOtp(key, code);
  const brand = input.brand === "headpinz" ? "HeadPinz" : "FastTrax";
  const sent = await voxSend(
    staff.mobile,
    `${brand}: your team member code is ${code}. It expires in 5 minutes. If you didn't request it, ignore this text.`,
    { category: "transactional" },
  ).catch(() => null);
  if (!sent || !sent.ok) return { ok: false, reason: "unavailable" };
  return {
    ok: true,
    challenge: sign("empc", { userId: staff.userId }, CHALLENGE_TTL_MS),
    maskedPhone: maskValue(staff.mobile, "phone"),
  };
}

// ── 2. Verify: code → token (+ link) ──────────────────────────────────────────

export type VerifyResult =
  | { ok: true; employee: SessionEmployee; linked: boolean }
  | { ok: false; reason: "incorrect"; attemptsLeft: number }
  | { ok: false; reason: "expired" | "locked" | "unverified" | "unavailable" | "disabled" };

/** Split a BMI "First Last" into the match shape. Middle names ride with the first. */
function personFromLicenseMatch(m: LicenseMatch): MatchablePerson {
  const parts = m.fullName.trim().split(/\s+/);
  const lastName = parts.length > 1 ? parts[parts.length - 1] : "";
  const firstName = parts.length > 1 ? parts.slice(0, -1).join(" ") : (parts[0] ?? "");
  return { id: m.personId, firstName, lastName, phone: m.phone || null, bmiPersonId: m.personId };
}

/**
 * With nobody on the booking matching, look the employee up in BMI directly by
 * last name + birth date (the licence-scan search) and phone, and pre-link when
 * exactly ONE record passes the rule. Zero or several (duplicate registrations)
 * → no pre-link; the match runs against the roster when they sign in.
 */
async function preLinkFromBmi(
  staff: StaffRecord,
  location: string | undefined,
): Promise<string | null> {
  if (!staff.birthDate) return null;
  let matches: LicenseMatch[];
  try {
    matches = await lookupLicenseMatches({
      lastName: staff.lastName,
      dobIso: staff.birthDate,
      firstName: staff.firstName,
      phone: staff.mobile ? staff.mobile.replace(/^\+1/, "") : undefined,
      location,
    });
  } catch (err) {
    console.warn(
      "[employee-perks] BMI pre-link search unavailable:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
  const verdict = matchEmployeeToParty(staff, matches.map(personFromLicenseMatch));
  if (!verdict.ok) return null;
  await upsertEmployeeLink({
    userId: staff.userId,
    bmiPersonId: verdict.memberId,
    clientKey: clientKeyForLookup(location),
    matchedBy: `bmi-search:${verdict.matchedBy}`,
  }).catch((err) => console.error("[employee-perks] pre-link write failed:", err));
  return verdict.memberId;
}

export async function verifyEmployeeCode(input: {
  challenge: string;
  code: string;
  party: MatchablePerson[];
  /** Kiosk center slug ("fasttrax" | "headpinz" | "naples") for the BMI search. */
  location?: string;
  source?: string;
}): Promise<VerifyResult> {
  if (!employeePerksEnabled()) return { ok: false, reason: "disabled" };
  const ch = open<{ userId?: unknown }>("empc", input.challenge);
  if (!ch || typeof ch.userId !== "number") return { ok: false, reason: "expired" };
  const userId = ch.userId;

  const code = (input.code ?? "").replace(/\D/g, "");
  if (code.length !== 6) return { ok: false, reason: "incorrect", attemptsLeft: 0 };
  const consumed = await consumeOtp(`emp:${userId}`, code);
  if (!consumed.ok) {
    if (consumed.reason === "incorrect") {
      return { ok: false, reason: "incorrect", attemptsLeft: consumed.attemptsLeft };
    }
    return { ok: false, reason: consumed.reason };
  }

  const rec = await getStaffRecord(userId);
  if (!rec.ok)
    return { ok: false, reason: rec.reason === "unavailable" ? "unavailable" : "unverified" };
  const staff = rec.staff;

  // Who on the booking is this person? Only lookup-sourced (BMI) members count.
  const match = matchEmployeeToParty(staff, input.party);
  let memberId: string | null = null;
  let bmiPersonId: string | null = null;
  if (match.ok) {
    memberId = match.memberId;
    bmiPersonId = input.party.find((p) => p.id === memberId)?.bmiPersonId ?? null;
    if (bmiPersonId) {
      await upsertEmployeeLink({
        userId,
        bmiPersonId,
        clientKey: clientKeyForLookup(input.location),
        matchedBy: `party:${match.matchedBy}`,
      }).catch((err) => console.error("[employee-perks] link write failed:", err));
    }
  } else {
    bmiPersonId = await preLinkFromBmi(staff, input.location);
  }

  const weekKey = payWeekKey();
  const usedThisWeek = await countFreeRacesUsed(userId, weekKey).catch(() => 0);
  const token = mintEmployeeToken({ userId, firstName: staff.firstName, memberId, bmiPersonId });
  if (!token) return { ok: false, reason: "unavailable" };
  return {
    ok: true,
    linked: !!bmiPersonId,
    employee: { userId, firstName: staff.firstName, memberId, token, usedThisWeek, weekKey },
  };
}

// ── 3. Recognize: a linked BMI person signs in → token, no code ──────────────

export type RecognizeResult =
  | { ok: true; employee: SessionEmployee }
  | { ok: false; reason: "not-linked" | "inactive" | "mismatch" | "unavailable" | "disabled" };

/**
 * A party member that a BMI LOOKUP produced (licence scan, phone OTP sign-in,
 * login code, web returning-racer lookup). Two ways in, no code either way:
 *
 *   a. The BMI person already carries a live link → re-check the user is still
 *      active AND the record still passes the name rule (a renamed BMI record
 *      drops the link) → token.
 *   b. NO link yet, but the BMI record's LAST NAME AND PHONE both equal an
 *      active 7shifts record → link it now (`auto:phone`) → token. Owner
 *      2026-09-13, after the first preview: "if we know the account is in BMI
 *      and it matches name and number, why would we reverify — we already
 *      required one to pull up the known account." The sign-in that produced
 *      the BMI person is the proof; the phone match is what ties it to 7shifts.
 *      The lenient first-name leg is NOT enough here — that is what the texted
 *      code is for (a BMI record whose phone differs from 7shifts).
 *
 * The caller asserts the sign-in was PROVEN; a typed name must never call this.
 */
export async function recognizeEmployee(input: {
  member: MatchablePerson;
  source?: string;
  location?: string;
}): Promise<RecognizeResult> {
  if (!employeePerksEnabled()) return { ok: false, reason: "disabled" };
  const personId = input.member.bmiPersonId;
  if (!personId) return { ok: false, reason: "not-linked" };

  let userId: number;
  let staff: StaffRecord;
  const link = await getEmployeeLinkForPerson(personId).catch(() => null);
  if (link) {
    const rec = await getStaffRecord(link.userId);
    if (!rec.ok) {
      return { ok: false, reason: rec.reason === "unavailable" ? "unavailable" : "inactive" };
    }
    // The LINK is the proof here (it was made on a phone match or a texted
    // code). Re-check only that the BMI record was not renamed since — NOT the
    // phone: web party members carry no phone (only the contact does), and a
    // phone demand here made every linked employee "mismatch" on web.
    if (normalizeNameToken(input.member.lastName) !== normalizeNameToken(rec.staff.lastName)) {
      return { ok: false, reason: "mismatch" };
    }
    userId = link.userId;
    staff = rec.staff;
    void touchEmployeeLink(userId, personId).catch(() => undefined);
  } else {
    // (b) auto-link: the BMI record's phone must resolve to ONE active 7shifts
    // user AND the last name must match. Phone-only or name-only never links.
    if (!input.member.phone) return { ok: false, reason: "not-linked" };
    const res = await resolveEmployee({ phone: input.member.phone });
    if (!res.ok) {
      return { ok: false, reason: res.reason === "unavailable" ? "unavailable" : "not-linked" };
    }
    const verdict = matchEmployeeToParty(res.staff, [input.member]);
    if (!verdict.ok || verdict.matchedBy !== "phone") return { ok: false, reason: "mismatch" };
    userId = res.staff.userId;
    staff = res.staff;
    await upsertEmployeeLink({
      userId,
      bmiPersonId: personId,
      clientKey: clientKeyForLookup(input.location),
      matchedBy: "auto:phone",
    }).catch((err) => console.error("[employee-perks] auto-link write failed:", err));
  }

  const weekKey = payWeekKey();
  const usedThisWeek = await countFreeRacesUsed(userId, weekKey).catch(() => 0);
  const token = mintEmployeeToken({
    userId,
    firstName: staff.firstName,
    memberId: input.member.id,
    bmiPersonId: personId,
  });
  if (!token) return { ok: false, reason: "unavailable" };
  return {
    ok: true,
    employee: {
      userId,
      firstName: staff.firstName,
      memberId: input.member.id,
      token,
      usedThisWeek,
      weekKey,
    },
  };
}

// ── 4. Reconcile: the check every price rail runs first ───────────────────────

/** The minimal session shape the reconcile touches (BookingSession satisfies it). */
export interface EmployeeSessionLike {
  employee?: SessionEmployee | null;
  party: Array<{
    id: string;
    bmiPersonId?: string;
    employeePerks?: { userId: number; firstName: string };
  }>;
}

export interface VerifiedEmployee {
  userId: number;
  firstName: string;
  memberId: string;
  weekKey: string;
  /** What the SESSION claims was used — the number the display priced with. */
  claimedUsedThisWeek: number;
}

/**
 * Server-authoritative employee state for a session about to be priced:
 *   - strips EVERY client-set `employeePerks` stamp;
 *   - verifies `session.employee.token`, re-checks the user is still active,
 *     requires the token's member to be on the party (and to be the same BMI
 *     person when the token names one);
 *   - re-stamps that one member.
 * Anything short of that prices as a plain guest, loudly.
 */
export async function applyEmployeeToSession<S extends EmployeeSessionLike>(
  session: S,
): Promise<{ session: S; employee: VerifiedEmployee | null; dropped: string | null }> {
  const claimed = session.employee;
  const clean = (
    dropped: string | null,
  ): { session: S; employee: null; dropped: string | null } => ({
    session: { ...session, employee: null, party: stampEmployeeOnParty(session.party, null) },
    employee: null,
    dropped,
  });
  if (!claimed) return clean(null);
  if (!employeePerksEnabled()) return clean("disabled");
  const tok = verifyEmployeeToken(claimed.token);
  if (!tok) return clean("bad-token");
  if (!tok.memberId) return clean("unmatched");
  const member = session.party.find((m) => m.id === tok.memberId);
  if (!member) return clean("member-missing");
  if (tok.bmiPersonId && member.bmiPersonId && member.bmiPersonId !== tok.bmiPersonId) {
    return clean("person-mismatch");
  }
  const rec = await getStaffRecord(tok.userId);
  // 7shifts unreachable AND no cached roster: fail CLOSED — a perk is a
  // discount, and an outage must not hand it to somebody deactivated today.
  if (!rec.ok) return clean(rec.reason === "unavailable" ? "roster-unavailable" : "inactive");

  const employee: SessionEmployee = {
    ...claimed,
    userId: tok.userId,
    firstName: rec.staff.firstName,
    memberId: tok.memberId,
    weekKey: claimed.weekKey || payWeekKey(),
    usedThisWeek: Math.max(0, Number(claimed.usedThisWeek) || 0),
  };
  return {
    session: { ...session, employee, party: stampEmployeeOnParty(session.party, employee) },
    employee: {
      userId: tok.userId,
      firstName: rec.staff.firstName,
      memberId: tok.memberId,
      weekKey: employee.weekKey,
      claimedUsedThisWeek: employee.usedThisWeek,
    },
    dropped: null,
  };
}

/** Fresh ledger read for the hard-fail check at charge time. */
export async function readFreeRacesUsed(userId: number, weekKey: string): Promise<number> {
  return countFreeRacesUsed(userId, weekKey);
}
