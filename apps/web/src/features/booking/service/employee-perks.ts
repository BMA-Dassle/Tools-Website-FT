/**
 * Employee perks — the PURE pricing walks, twins of `bogo-scheduled.ts`.
 *
 *   computeEmployeeFreeHeats        which SINGLE-race heats each team member's
 *                                   weekly allowance prices to $0 (their own,
 *                                   session order)
 *   employeeAttractionUnits         how many units of a gel-blaster / laser-tag
 *                                   line are team members' own (kiosk: assigned
 *                                   units; web: one each, since the web never
 *                                   says who plays)
 *   employeeRacingSavingsByMember   cents the 50% removed from each member's
 *                                   own racing lines — the per-employee ledger
 *                                   figure, never a charge input
 *
 * PURE — no vendor calls, no env, no `now`-at-module-load. The charge builder
 * (unified-reserve), the checkout review and the cart estimate all call THESE
 * with their own exclusion sets, so displayed can never drift from charged.
 *
 * WHO. A team member is a party member carrying `employeePerks` — stamped by
 * the client reducer for display and RE-DERIVED from the signed tokens by the
 * server before any charge (programs/employee.server.ts). SEVERAL members can
 * be stamped (owner 2026-09-14: two employees racing together is the normal
 * case) — each one is priced on their OWN items against their OWN allowance.
 * A session with no stamped member prices as plain guests, whatever
 * `session.employees` claims.
 *
 * WHERE IN THE COVERAGE ORDER. After credits, packs and vouchers — the
 * allowance covers only heats that would otherwise be paid in CASH — and
 * BEFORE BOGO, which the employee never pairs into anyway (the pass blocks it;
 * `racingPassBlocksBogo`).
 */
import { getRaceProductById, priceOnDate } from "./race-products";
import { bestPercentOffForCategory, entitlementsForMember } from "./membership-discounts";
import { buildRaceChargeLines } from "./checkout";
import {
  freeRacesRemaining,
  isEmployeeAttractionSlug,
  type EmployeePerksStamp,
  type SessionEmployee,
} from "~/features/discount-codes/programs/employee";
import type { BookingSession, RaceHeatAssignment } from "../state/types";

type PerkMember = { id: string; employeePerks?: EmployeePerksStamp };

/** Every stamped team member on this party — one per verified employee. */
export function employeeMembers<T extends PerkMember>(party: T[]): T[] {
  return party.filter((m) => !!m.employeePerks);
}

export interface EmployeeFreeHeats {
  /** The exact heat ASSIGNMENTS priced to $0 (object identity — the same
   *  contract as redeemedHeatSet / computePackCoverage / BOGO). */
  heats: Set<RaceHeatAssignment>;
  /** The members whose heats were freed (empty when nothing was). */
  memberIds: string[];
}

/**
 * Which of each team member's own SINGLE-race heats their weekly allowance
 * covers.
 *
 * Singles only (owner 2026-09-13): package component heats (per category) and
 * multi-race pack products are bundle-priced and never consume a free race.
 * Heats another instrument already covers (credit, pack, voucher) are skipped —
 * the allowance is not spent on a race that was already free. Session order,
 * up to `freeRacesRemaining` of the employee whose `memberId` is the heat's
 * racer — allowances never pool across members; a heat with no date or no id
 * never counts (there is no race to give away yet).
 */
export function computeEmployeeFreeHeats(
  items: Array<{
    kind: string;
    date?: string | null;
    packageIdAdult?: string | null;
    packageIdJunior?: string | null;
    heats?: RaceHeatAssignment[];
  }>,
  party: PerkMember[],
  alreadyCovered: ReadonlySet<RaceHeatAssignment>,
  employees: ReadonlyArray<Pick<SessionEmployee, "memberId" | "usedThisWeek">> | null | undefined,
): EmployeeFreeHeats {
  const heats = new Set<RaceHeatAssignment>();
  const freed = new Set<string>();
  const members = employeeMembers(party);
  if (members.length === 0 || !employees?.length) return { heats, memberIds: [] };

  // Free races left per STAMPED member — read from the employee whose token
  // named that member. A stamp with no matching employee (cannot happen after
  // the server reconcile; a display-only edge on the client) frees nothing.
  const remaining = new Map<string, number>();
  for (const m of members) {
    const left = freeRacesRemaining(employees.find((e) => e.memberId === m.id));
    if (left > 0) remaining.set(m.id, left);
  }
  if (remaining.size === 0) return { heats, memberIds: [] };

  for (const item of items) {
    if (item.kind !== "race" || !item.heats || !item.date) continue;
    for (const h of item.heats) {
      if (!h.heatId || !h.assignedTo) continue;
      const left = remaining.get(h.assignedTo) ?? 0;
      if (left <= 0) continue;
      if (alreadyCovered.has(h)) continue;
      const heatPkg =
        (h.category ?? "adult") === "junior" ? item.packageIdJunior : item.packageIdAdult;
      if (heatPkg) continue;
      if (getRaceProductById(h.productId)?.packType === "combo") continue;
      heats.add(h);
      freed.add(h.assignedTo);
      remaining.set(h.assignedTo, left - 1);
    }
  }
  return { heats, memberIds: [...freed] };
}

/** Attraction slug → the discount category the entitlement config uses. */
export function attractionDiscountCategory(slug: string | null | undefined) {
  if (slug === "gel-blaster") return "gel-blasters" as const;
  if (slug === "laser-tag") return "laser-tag" as const;
  return null;
}

export interface EmployeeAttractionSplit {
  /** Own units across every team member on the line (capped at the line qty). */
  units: number;
  /** The entitlement percent (Employee Pass 50% — one entitlement key, one
   *  percent for everyone; the max is taken should a second rail ever differ). */
  percentOff: number;
  /** Own units per stamped member — the per-employee ledger attribution. */
  byMember: Array<{ memberId: string; units: number }>;
}

/**
 * How many units of this attraction line are TEAM MEMBERS' OWN, and at what
 * percent off. Kiosk lines name their players (`participants` / `assignedTo`):
 * count each stamped member's entries. The WEB never writes who plays, so
 * there each employee in the party owns exactly ONE unit — a qty-3 web line
 * cannot say who the others are (owner 2026-09-13). Never more units than the
 * line has: members are served in party order until the line runs out.
 */
export function employeeAttractionUnits(
  attr: { slug: string | null; qty: number; participants?: string[]; assignedTo?: string[] },
  party: Array<PerkMember & { memberships?: string[] }>,
): EmployeeAttractionSplit {
  const none: EmployeeAttractionSplit = { units: 0, percentOff: 0, byMember: [] };
  if (!isEmployeeAttractionSlug(attr.slug)) return none;
  const category = attractionDiscountCategory(attr.slug);
  if (!category) return none;
  const named = attr.participants?.length ? attr.participants : (attr.assignedTo ?? []);
  let room = Math.max(0, attr.qty);
  let percentOff = 0;
  const byMember: EmployeeAttractionSplit["byMember"] = [];
  for (const member of employeeMembers(party)) {
    if (room <= 0) break;
    const pct = bestPercentOffForCategory(entitlementsForMember(member), category);
    if (pct <= 0) continue;
    const own = named.length > 0 ? named.filter((id) => id === member.id).length : 1;
    const units = Math.min(Math.max(0, own), room);
    if (units <= 0) continue;
    room -= units;
    percentOff = Math.max(percentOff, pct);
    byMember.push({ memberId: member.id, units });
  }
  const units = byMember.reduce((s, b) => s + b.units, 0);
  return units > 0 ? { units, percentOff, byMember } : none;
}

/** Round to the cent. */
export function discountedUnitCents(unitCents: number, percentOff: number): number {
  return Math.round(unitCents * (1 - percentOff / 100));
}

/** Price of a heat on its item's date — the same resolver the charge uses. */
export function heatPriceCents(h: RaceHeatAssignment, date: string | null | undefined): number {
  const p = getRaceProductById(h.productId);
  return p ? Math.round(priceOnDate(p, date ?? null) * 100) : 0;
}

/**
 * Cents the 50% removed from each team member's OWN racing lines — the
 * per-employee audit figure for the perk ledger (Square cannot tell us; the
 * discount is a price-key reduction). Differenced from the ONE line builder
 * the charge uses: the lines with THIS member's stamp lifted, minus the lines
 * as charged, so it can never disagree with the split lines. A member whose
 * 50% also comes from the BMI Employee Pass membership shows $0 — that
 * discount is the membership's, not this program's. Never a charge input.
 */
export function employeeRacingSavingsByMember(
  session: BookingSession,
  excludedHeats: Set<RaceHeatAssignment>,
): Map<string, number> {
  const out = new Map<string, number>();
  const members = employeeMembers(session.party);
  if (members.length === 0) return out;
  const totalCents = (party: BookingSession["party"]) =>
    Math.round(
      buildRaceChargeLines({ ...session, party }, excludedHeats).reduce((s, l) => s + l.amount, 0) *
        100,
    );
  const charged = totalCents(session.party);
  for (const m of members) {
    const lifted = session.party.map((p) => {
      if (p.id !== m.id) return p;
      const { employeePerks: _drop, ...rest } = p;
      void _drop;
      return rest as typeof p;
    });
    const saved = totalCents(lifted) - charged;
    if (saved > 0) out.set(m.id, saved);
  }
  return out;
}
