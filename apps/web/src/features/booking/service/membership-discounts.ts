/**
 * Membership discounts & restrictions — declarative config, mirroring how
 * `lib/packages.ts` defines packages. One entry per membership that grants a
 * price benefit; the booking flow detects which ones a (verified) customer
 * holds and applies the benefit by editing the Square day-of order line prices.
 *
 * DETECTION = an ACTIVE BMI **membership** (the person's `memberships[]` array,
 * `{ membershipKindId, name, starts, stops }` from /api/bmi-office?action=person).
 * A membership counts when `starts <= now <= stops`. The Pandora **deposit**
 * also named "Employee Pass" (DPK 12754843) is a SEPARATE thing reserved for
 * later (usage tracking) — it is NOT the discount trigger.
 *
 * IMPORTANT — detect on the CANONICAL person, never the booking flow's
 * throwaway auto-created person. Eric's real record is personId 409523 (active
 * Employee Pass membership 12754847, 2026-04-04 → 2027-04-04); the per-booking
 * auto-persons have no such membership. Resolve the person via login code / a
 * verified lookup before checking `activeMembershipDiscounts`.
 */

/** What a discount can apply to. A Square day-of line is mapped to one of these. */
export type DiscountCategory = "racing" | "gel-blasters" | "laser-tag" | "bowling" | "attractions";

export interface MembershipDiscount {
  /** Stable key (kebab-case). */
  key: string;
  /** Customer-facing label (matches the BMI membership name). */
  label: string;
  /**
   * BMI membership kind id — the most robust discount trigger (active membership
   * of this kind). Optional: when unknown, detection falls back to `membershipName`.
   */
  membershipKindId?: string;
  /** Membership name as it appears in the person's memberships[] (case-insensitive). */
  membershipName: string;
  /**
   * Pandora deposit kind also named like this membership (e.g. "Employee Pass"
   * = DPK 12754843). Reserved for LATER use (usage tracking / decrementing) —
   * NOT the discount trigger. Optional.
   */
  pandoraDepositKindId?: string;
  /** Percent off the line's base price for matching categories (0–100). */
  percentOff: number;
  /** Which line categories the discount applies to. */
  categories: DiscountCategory[];
  enabled: boolean;
}

/**
 * The catalog of membership discounts. Add a row to grant a new membership a benefit.
 */
export const MEMBERSHIP_DISCOUNTS: MembershipDiscount[] = [
  {
    key: "employee-pass",
    label: "Employee Pass",
    membershipKindId: "12754847",
    membershipName: "Employee Pass",
    pandoraDepositKindId: "12754843", // deposit "Employee Pass" — reserved for later, NOT the trigger
    percentOff: 50,
    categories: ["racing", "gel-blasters", "laser-tag"],
    enabled: true,
  },
  {
    key: "league-racer",
    label: "League Racer",
    // membershipKindId unknown — detected by name until backfilled with the kind id.
    membershipName: "League Racer",
    percentOff: 20,
    categories: ["racing"],
    enabled: true,
  },
];

/** One row of a BMI person's `memberships[]` array. */
export interface PersonMembership {
  membershipKindId?: string | number;
  name: string;
  /** ISO start — membership is active from here. */
  starts?: string | null;
  /** ISO stop — membership is active until here. */
  stops?: string | null;
}

/** Is a membership currently within its active window? */
function isActive(m: PersonMembership, nowMs: number): boolean {
  const start = m.starts ? new Date(m.starts).getTime() : Number.NEGATIVE_INFINITY;
  const stop = m.stops ? new Date(m.stops).getTime() : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(start) && m.starts) return false;
  return nowMs >= start && nowMs <= stop;
}

/**
 * The membership discounts this person is entitled to, from their memberships[].
 * A discount is active when its membership kind (or name) appears in an ACTIVE
 * (`starts <= now <= stops`) membership row.
 */
export function activeMembershipDiscounts(
  memberships: PersonMembership[],
  now: Date | string | number = Date.now(),
): MembershipDiscount[] {
  const nowMs = new Date(now).getTime();
  const activeKindIds = new Set<string>();
  const activeNames = new Set<string>();
  for (const m of memberships ?? []) {
    if (!isActive(m, nowMs)) continue;
    if (m.membershipKindId != null) activeKindIds.add(String(m.membershipKindId));
    if (m.name) activeNames.add(m.name.trim().toLowerCase());
  }
  return MEMBERSHIP_DISCOUNTS.filter(
    (d) =>
      d.enabled &&
      ((d.membershipKindId != null && activeKindIds.has(d.membershipKindId)) ||
        activeNames.has(d.membershipName.toLowerCase())),
  );
}

/** Highest percent-off available for a category across the active discounts. */
export function bestPercentOffForCategory(
  discounts: MembershipDiscount[],
  category: DiscountCategory,
): number {
  return discounts.reduce(
    (max, d) => (d.categories.includes(category) ? Math.max(max, d.percentOff) : max),
    0,
  );
}

/** A Square-ish line item to discount. `category` must be resolved by the caller. */
export interface DiscountableLine {
  /** Square order line uid (so the caller can target the PUT). */
  uid?: string;
  name: string;
  /** Per-unit base price in cents BEFORE the membership discount. */
  basePriceCents: number;
  category: DiscountCategory | null;
}

export interface DiscountedLine extends DiscountableLine {
  /** Per-unit price after the discount (rounded to the cent). */
  newBasePriceCents: number;
  percentOff: number;
  /** The membership that produced the best discount on this line. */
  appliedKey: string | null;
}

/**
 * Pure calculator: given lines (each pre-tagged with a category) and the active
 * membership discounts, return each line with its discounted per-unit price.
 * Lines with no matching category are returned unchanged (percentOff 0). The
 * caller turns `newBasePriceCents` into a Square line `base_price_money` PUT.
 */
export function applyMembershipDiscounts(
  lines: DiscountableLine[],
  discounts: MembershipDiscount[],
): DiscountedLine[] {
  return lines.map((line) => {
    if (!line.category) {
      return { ...line, newBasePriceCents: line.basePriceCents, percentOff: 0, appliedKey: null };
    }
    let best = 0;
    let appliedKey: string | null = null;
    for (const d of discounts) {
      if (d.categories.includes(line.category) && d.percentOff > best) {
        best = d.percentOff;
        appliedKey = d.key;
      }
    }
    const newBasePriceCents =
      best > 0 ? Math.round(line.basePriceCents * (1 - best / 100)) : line.basePriceCents;
    return { ...line, newBasePriceCents, percentOff: best, appliedKey };
  });
}
