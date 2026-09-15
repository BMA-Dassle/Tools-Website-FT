/**
 * EMPLOYEE PERKS — the program, PURE. No DB, no network, no `process.env`.
 *
 * Owner brief (2026-09-13): team members verified through 7shifts get
 *   - 50% off their OWN single races, gel blaster and laser tag;
 *   - 2 free single races per PAY week (Wed–Tue, the same period the daily
 *     events pages already use);
 *   - Game Zone cards at FULL price, with the bought tokens loaded again as
 *     bonus tokens (100 → 100 + 100 bonus).
 *
 * WHY IT LIVES WITH THE DISCOUNT CODES. It is the second discount PROGRAM after
 * typed codes, and the owner asked for every discount/voucher mechanism to sit
 * together. It is deliberately NOT expressed as an `AppliedPromo`: the promo
 * seam prices whole cart lines, while these perks are per PERSON and per
 * category — exactly the shape the Employee Pass BMI membership already has in
 * `booking/service/membership-discounts.ts`. So the 50% is projected as that
 * same `employee-pass` entitlement (same key ⇒ the two sources can never stack;
 * a member is entitled or not), and racing lines split exactly as today.
 *
 * WHAT IS PROVEN WHERE. Identity is the 7shifts user id, proven by a one-time
 * code texted to the mobile 7shifts holds (`employee.server.ts`). That proof is
 * a signed token on the booking session; the client's copy of any perk field is
 * a display hint, and every charge path re-derives the stamp from the token.
 *
 * WHICH PERSON. Each verified employee's perks attach to ONE party member — that
 * employee's own BMI record. `matchEmployeeToParty` is the rule (owner
 * 2026-09-13, final: "only checking last and phone for booked products"): the
 * BMI record's LAST NAME must equal 7shifts AND its PHONE must equal the 7shifts
 * mobile. First names are never a factor — nicknames vs legal names made them
 * unreliable, and the phone is the second factor that ties the record to the
 * roster.
 *
 * HOW MANY. SEVERAL team members can verify on one booking (owner 2026-09-14:
 * two employees racing together after a shift is the normal case). The session
 * carries `employees: SessionEmployee[]` — one token, one matched member and
 * one weekly allowance EACH; a party member holds at most one stamp, and a
 * 7shifts user appears at most once (`upsertSessionEmployee`).
 */

import type { MembershipDiscount } from "~/features/booking/service/membership-discounts";
import { getWeekPeriod, toDateStr } from "~/features/daily-events/week";
import { canonicalizePhone } from "@/lib/participant-contact";

export const EMPLOYEE_PROGRAM = {
  key: "employee",
  /** Percent off the employee's own eligible units. */
  percentOff: 50,
  /** Free SINGLE races per pay week (Wed–Tue). */
  freeRacesPerWeek: 2,
  /** Game Zone: bonus tokens added = bought tokens × (multiplier − 1). */
  gameZoneTokenMultiplier: 2,
  /** Attraction slugs the 50% reaches (AttractionItem.slug). */
  attractionSlugs: ["gel-blaster", "laser-tag"] as readonly string[],
} as const;

/**
 * The entitlement a verified employee carries — SAME KEY as the Employee Pass
 * BMI membership row in MEMBERSHIP_DISCOUNTS, so `entitlementsForMember`
 * dedups the two sources into one and 50% can never become 75%.
 */
export const EMPLOYEE_ENTITLEMENT: MembershipDiscount = {
  key: "employee-pass",
  label: "Employee Pass",
  membershipName: "Employee Pass",
  percentOff: EMPLOYEE_PROGRAM.percentOff,
  categories: ["racing", "gel-blasters", "laser-tag"],
  enabled: true,
};

/** Stamped on the ONE party member the verified employee is. Display hint on the
 *  client; re-derived from the token on the server before any pricing. */
export interface EmployeePerksStamp {
  /** 7shifts user id. */
  userId: number;
  firstName: string;
}

/**
 * What the booking session carries once a team member has verified.
 * `token` is the proof (HMAC, server-minted, short-lived); everything else is
 * what the client shows and what the pure pricing helpers read.
 */
export interface SessionEmployee {
  userId: number;
  firstName: string;
  /** The party member the perks attach to — null until a match is made. */
  memberId: string | null;
  /** Signed proof. Verified server-side at quote AND at charge. */
  token: string;
  /** Free single races already used this pay week, as the server last read it.
   *  The pricing helpers subtract this from the allowance; the charge path
   *  re-reads the ledger and HARD-FAILS if the count moved up. */
  usedThisWeek: number;
  /** The pay-week key the count belongs to (`weekKey`). */
  weekKey: string;
}

/**
 * The verified team members on a session. Reads the current `employees` list;
 * a session persisted BEFORE 2026-09-14 (sessionStorage on the web, a kiosk
 * tab mid-booking at deploy time) still carries the single legacy `employee`
 * field — honoured here so nobody mid-checkout loses their perks. Every
 * reader goes through this, never `session.employees` directly.
 */
export function sessionEmployees(
  session:
    | { employees?: ReadonlyArray<SessionEmployee> | null; employee?: SessionEmployee | null }
    | null
    | undefined,
): SessionEmployee[] {
  if (!session) return [];
  if (Array.isArray(session.employees)) return [...session.employees];
  return session.employee ? [session.employee] : [];
}

/**
 * Add (or refresh) a verified employee on the list, PURELY. A 7shifts user
 * appears once (re-verifying replaces the earlier token), and a party member
 * carries at most one employee (the later verification wins the member).
 */
export function upsertSessionEmployee(
  list: ReadonlyArray<SessionEmployee>,
  employee: SessionEmployee,
): SessionEmployee[] {
  const kept = list.filter(
    (e) =>
      e.userId !== employee.userId &&
      !(employee.memberId && e.memberId && e.memberId === employee.memberId),
  );
  return [...kept, employee];
}

/** Drop one verified employee (the "Remove" on their perks bar). */
export function removeSessionEmployee(
  list: ReadonlyArray<SessionEmployee>,
  userId: number,
): SessionEmployee[] {
  return list.filter((e) => e.userId !== userId);
}

/** Charge-time perk usage the ledger records, keyed by kind. */
export type EmployeePerkKind = "free-race" | "percent-off" | "gz-double-tokens";

/**
 * The Wed–Tue PAY WEEK a moment belongs to, as `YYYY-MM-DD` of its Wednesday
 * in ET — the same period math the daily-events pages ship (`getWeekPeriod`).
 */
export function payWeekKey(now: Date = new Date()): string {
  return toDateStr(getWeekPeriod(now).start);
}

/** Letters only, lower-case, diacritics stripped — how names are compared. */
export function normalizeNameToken(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/** The 7shifts side of the match — a structural subset of `StaffRecord`. */
export interface EmployeeNameKey {
  firstName: string;
  legalFirstName?: string | null;
  lastName: string;
  /** E.164. */
  mobile?: string | null;
}

/** The booking side of the match — a structural subset of `PartyMember`
 *  (and of the kiosk's `LicenseMatch`, once its full name is split). */
export interface MatchablePerson {
  id: string;
  firstName: string;
  lastName?: string | null;
  phone?: string | null;
  /** Only a person the BMI lookup produced can be linked — a typed name is not
   *  a BMI account. Callers pass the BMI person id when they have one. */
  bmiPersonId?: string | null;
}

export type EmployeeMatch =
  | { ok: true; memberId: string; matchedBy: "phone" }
  | { ok: false; reason: "none" | "ambiguous" };

/**
 * Pick the ONE party member who is the verified employee.
 *
 *   1. LAST NAME must equal the 7shifts last name (normalized).
 *   2. PHONE must equal the 7shifts mobile (E.164).
 *   3. Exactly one passes → link; several → ambiguous, no link.
 *
 * Only members with a BMI person id are candidates (a hand-typed party entry is
 * not an account to link), unless `allowUnlinked` is set — the web contact
 * step sometimes has the employee only as a typed racer before the lookup.
 */
export function matchEmployeeToParty(
  staff: EmployeeNameKey,
  party: MatchablePerson[],
  opts: { allowUnlinked?: boolean } = {},
): EmployeeMatch {
  const last = normalizeNameToken(staff.lastName);
  if (!last) return { ok: false, reason: "none" };
  const mobile = staff.mobile ? canonicalizePhone(staff.mobile) : null;

  // No 7shifts mobile ⇒ nothing can pass: the phone IS the second factor.
  if (!mobile) return { ok: false, reason: "none" };

  const passing: string[] = [];
  for (const p of party) {
    if (!p.bmiPersonId && !opts.allowUnlinked) continue;
    if (normalizeNameToken(p.lastName) !== last) continue;
    if (canonicalizePhone(p.phone ?? null) !== mobile) continue;
    passing.push(p.id);
  }

  if (passing.length === 0) return { ok: false, reason: "none" };
  if (passing.length === 1) return { ok: true, memberId: passing[0], matchedBy: "phone" };
  // Two BMI records with the same surname AND the same phone (a duplicate
  // registration, or family sharing a number) — refuse rather than guess.
  return { ok: false, reason: "ambiguous" };
}

/** Does this attraction slug get the employee 50%? */
export function isEmployeeAttractionSlug(slug: string | null | undefined): boolean {
  return !!slug && EMPLOYEE_PROGRAM.attractionSlugs.includes(slug);
}

/**
 * Game Zone doubling: the card loads the BOUGHT tokens as regular tokens and
 * the same amount again as BONUS, on top of any bonus the pack already carries
 * (100 → 100 + 100; 300+50 → 300 + 350). Price is untouched by design — the
 * doubling is the perk, not a discount.
 */
export function employeeGameZoneCredit(pkg: { tokens: number; bonusTokens: number }): {
  tokens: number;
  bonusTokens: number;
} {
  const extra = pkg.tokens * (EMPLOYEE_PROGRAM.gameZoneTokenMultiplier - 1);
  return { tokens: pkg.tokens, bonusTokens: pkg.bonusTokens + extra };
}

/** Free single races still available this pay week for a verified employee. */
export function freeRacesRemaining(
  employee: Pick<SessionEmployee, "usedThisWeek"> | null | undefined,
) {
  if (!employee) return 0;
  return Math.max(0, EMPLOYEE_PROGRAM.freeRacesPerWeek - Math.max(0, employee.usedThisWeek));
}

/**
 * Stamp (or clear) the employee perks on the party, PURELY. Each member named
 * by an employee's `memberId` carries THAT employee's stamp; every other
 * member's stamp is removed, so a stale stamp from a previous match can never
 * survive a re-match or a Remove. Used by the client reducer (display) AND the
 * server reconcile (charge), so the two can never disagree about who the
 * employees are.
 */
export function stampEmployeeOnParty<T extends { id: string; employeePerks?: EmployeePerksStamp }>(
  party: T[],
  employees:
    | ReadonlyArray<Pick<SessionEmployee, "userId" | "firstName" | "memberId">>
    | null
    | undefined,
): T[] {
  const byMember = new Map<string, EmployeePerksStamp>();
  for (const e of employees ?? []) {
    if (e.memberId) byMember.set(e.memberId, { userId: e.userId, firstName: e.firstName });
  }
  return party.map((m) => {
    const { employeePerks: _drop, ...rest } = m;
    void _drop;
    const stamp = byMember.get(m.id);
    return (stamp ? { ...rest, employeePerks: stamp } : rest) as T;
  });
}

/** The ledger marker on a Game Zone card row bought by a verified team member. */
export const EMPLOYEE_GZ_PERK = "employee-2x";
