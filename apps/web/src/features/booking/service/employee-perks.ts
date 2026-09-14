/**
 * Employee perks — the PURE pricing walks, twins of `bogo-scheduled.ts`.
 *
 *   computeEmployeeFreeHeats   which SINGLE-race heats the weekly allowance
 *                              prices to $0 (the employee's own, session order)
 *   employeeAttractionUnits    how many units of a gel-blaster / laser-tag line
 *                              are the employee's own (kiosk: assigned units;
 *                              web: one, since the web never says who plays)
 *   employeeReviewSummary      the one-line "You saved" figure for the review
 *
 * PURE — no vendor calls, no env, no `now`-at-module-load. The charge builder
 * (unified-reserve), the checkout review and the cart estimate all call THESE
 * with their own exclusion sets, so displayed can never drift from charged.
 *
 * WHO. The employee is the party member carrying `employeePerks` — stamped by
 * the client reducer for display and RE-DERIVED from the signed token by the
 * server before any charge (programs/employee.server.ts). A session with no
 * stamped member prices as a plain guest, whatever `session.employee` claims.
 *
 * WHERE IN THE COVERAGE ORDER. After credits, packs and vouchers — the
 * allowance covers only heats that would otherwise be paid in CASH — and
 * BEFORE BOGO, which the employee never pairs into anyway (the pass blocks it;
 * `racingPassBlocksBogo`).
 */
import { getRaceProductById, priceOnDate } from "./race-products";
import { bestPercentOffForCategory, entitlementsForMember } from "./membership-discounts";
import {
  freeRacesRemaining,
  isEmployeeAttractionSlug,
  type EmployeePerksStamp,
  type SessionEmployee,
} from "~/features/discount-codes/programs/employee";
import type { RaceHeatAssignment } from "../state/types";

type PerkMember = { id: string; employeePerks?: EmployeePerksStamp };

/** The stamped employee on this party, or null. Exactly one by construction. */
export function employeeMember<T extends PerkMember>(party: T[]): T | null {
  return party.find((m) => !!m.employeePerks) ?? null;
}

export interface EmployeeFreeHeats {
  /** The exact heat ASSIGNMENTS priced to $0 (object identity — the same
   *  contract as redeemedHeatSet / computePackCoverage / BOGO). */
  heats: Set<RaceHeatAssignment>;
  /** The member they belong to (null when nothing was freed). */
  memberId: string | null;
}

/**
 * Which of the employee's own SINGLE-race heats the weekly allowance covers.
 *
 * Singles only (owner 2026-09-13): package component heats (per category) and
 * multi-race pack products are bundle-priced and never consume a free race.
 * Heats another instrument already covers (credit, pack, voucher) are skipped —
 * the allowance is not spent on a race that was already free. Session order,
 * up to `freeRacesRemaining(employee)`; a heat with no date or no id never
 * counts (there is no race to give away yet).
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
  employee: Pick<SessionEmployee, "usedThisWeek"> | null | undefined,
): EmployeeFreeHeats {
  const heats = new Set<RaceHeatAssignment>();
  const member = employeeMember(party);
  let remaining = freeRacesRemaining(employee);
  if (!member || remaining <= 0) return { heats, memberId: null };

  for (const item of items) {
    if (remaining <= 0) break;
    if (item.kind !== "race" || !item.heats || !item.date) continue;
    for (const h of item.heats) {
      if (remaining <= 0) break;
      if (!h.heatId || h.assignedTo !== member.id) continue;
      if (alreadyCovered.has(h)) continue;
      const heatPkg =
        (h.category ?? "adult") === "junior" ? item.packageIdJunior : item.packageIdAdult;
      if (heatPkg) continue;
      if (getRaceProductById(h.productId)?.packType === "combo") continue;
      heats.add(h);
      remaining -= 1;
    }
  }
  return { heats, memberId: heats.size > 0 ? member.id : null };
}

/** Attraction slug → the discount category the entitlement config uses. */
export function attractionDiscountCategory(slug: string | null | undefined) {
  if (slug === "gel-blaster") return "gel-blasters" as const;
  if (slug === "laser-tag") return "laser-tag" as const;
  return null;
}

/**
 * How many units of this attraction line are the EMPLOYEE'S OWN, and at what
 * percent off. Kiosk lines name their players (`participants` / `assignedTo`):
 * count the employee's entries. The WEB never writes who plays, so there the
 * employee's own count is exactly ONE unit when they are in the party — a
 * qty-3 web line cannot say who the other two are (owner 2026-09-13).
 */
export function employeeAttractionUnits(
  attr: { slug: string | null; qty: number; participants?: string[]; assignedTo?: string[] },
  party: Array<PerkMember & { memberships?: string[] }>,
): { units: number; percentOff: number } {
  const none = { units: 0, percentOff: 0 };
  if (!isEmployeeAttractionSlug(attr.slug)) return none;
  const member = employeeMember(party);
  if (!member) return none;
  const category = attractionDiscountCategory(attr.slug);
  if (!category) return none;
  const percentOff = bestPercentOffForCategory(entitlementsForMember(member), category);
  if (percentOff <= 0) return none;
  const named = attr.participants?.length ? attr.participants : (attr.assignedTo ?? []);
  const own = named.length > 0 ? named.filter((id) => id === member.id).length : 1;
  return { units: Math.min(Math.max(0, own), Math.max(0, attr.qty)), percentOff };
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
