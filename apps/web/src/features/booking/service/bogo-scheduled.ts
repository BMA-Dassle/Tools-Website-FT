/**
 * BOGO Wednesdays as a SCHEDULED-RACE pricing rule (owner 2026-08-31: "this
 * special is here to stay and was never meant to be a race pack — buy one get
 * one, all races must be scheduled").
 *
 * On a Wednesday race date, every SECOND scheduled single race per racer is
 * FREE — priced directly on the booked heats. No credit pack is purchased, no
 * credits grant, nothing banks: the free race exists only as a scheduled heat
 * in the same booking. This replaced the returning-racer BOGO CREDIT PACK
 * (v1.28.0, reverted unreleased), whose one-deal-per-order rule made guests
 * pay and walk back to the kiosk for a second deal, and whose banked Mon–Thu
 * credit was more generous than the advertised deal.
 *
 * Owner decisions (2026-08-31):
 *  - EVERY 2ND RACE FREE, floor pairing — 3 scheduled races = pay 2, get 1
 *    free. Each free race always rides a full-price one.
 *  - NO CAP — heat-conflict spacing already bounds a day, and every free race
 *    rides a paid one, so margin is protected at any volume.
 *  - FIRST-TIMERS KEEP THE PACKAGE — the `bogo-weekday` PACKAGE (Starter +
 *    Intermediate booked outright at one price) already is scheduled
 *    buy-one-get-one, with the level-up disclaimer machinery this rule has no
 *    reason to duplicate. Package component heats are excluded here, so the
 *    two halves can never stack. A first-timer's plain single races DO pair —
 *    one advertised rule, "every second race is free on Wednesdays".
 *
 * WHERE IT SITS IN THE CHARGE ORDER: after credits, packs and vouchers — the
 * rule pairs only the heats that would otherwise be paid in CASH. A heat a
 * credit/voucher already covers is not "bought", so it neither goes free nor
 * anchors a pair. That also means the deal never spends a guest's banked
 * credit on a race this rule would have given them free... almost: credits
 * cover heats in session order BEFORE this rule runs, so a credit-holder's
 * uncovered remainder still pairs 2-for-1. Every direction of that stacking
 * is guest-favorable or neutral, never a double discount of one heat.
 *
 * WHICH OF A PAIR IS FREE: the cheaper one (retail "free item of equal or
 * lesser value" — mixed-track/tier heats can price differently). Ties keep
 * the LATER heat free, matching how the pairs read on the review. Pairing is
 * per racer, per race item, in session heat order — the same walk every other
 * coverage computation uses, so display and charge free identical heats.
 *
 * The day rule is `bogoSaleActive` — the SAME rule the first-timer package
 * half reads (bogo-sale.test.ts pins them equal), keyed off the RACE DATE
 * with its `from` floor. An item with no date yet never pairs (an in-booking
 * race always has one before heats exist; there is no walk-up fallback here
 * because there is no purchase instant — the heats ARE the promo).
 *
 * PURE — no vendor calls, no env. The charge builder, the checkout review and
 * the cart estimate all call THIS function with their own exclusion sets, so
 * displayed can never drift from charged (the displayed==charged rule).
 */
import { bogoSaleActive } from "../data/packs";
import { getRaceProductById } from "./race-products";
import { membershipDiscountsForNames } from "./membership-discounts";
import type { RaceHeatAssignment } from "../state/types";

/**
 * Does a racing membership discount BLOCK this racer from BOGO pairing?
 * Owner 2026-08-31 (preview smoke): "cannot combine employee pass with BOGO
 * Wednesday — employee pass takes priority." A racer whose memberships grant
 * any RACING percent-off gets their pass pricing on every heat and no free
 * races: the two never stack (an Employee Pass 50% pair would otherwise land
 * at a quarter price). For the Employee Pass specifically the exclusion is
 * money-neutral by construction — 50% off two races IS buy-one-get-one.
 * Exported so the pay-mode banner can hide the ad from a party it won't apply
 * to.
 */
export function racingPassBlocksBogo(memberships?: string[]): boolean {
  return membershipDiscountsForNames(memberships ?? []).some(
    (d) => d.percentOff > 0 && d.categories.includes("racing"),
  );
}

export interface BogoScheduledFree {
  /** The exact heat ASSIGNMENTS the rule prices to $0 (object identity — the
   *  same contract as redeemedHeatSet / computePackCoverage). */
  heats: Set<RaceHeatAssignment>;
  /** memberId → free heats granted (copy: "2nd race free ×N"). */
  freeByMember: Map<string, number>;
}

/**
 * Which scheduled heats does BOGO Wednesday make free?
 *
 * `alreadyCovered` = every heat some other instrument prices to $0 first
 * (credit-redeemed, pack-covered, voucher-comped) — those heats neither pair
 * nor go free. Package component heats (per category) and booked combo pack
 * products are excluded exactly like every other coverage walk. `party`
 * carries each racer's membership names: a racer with a racing pass discount
 * is excluded entirely (`racingPassBlocksBogo` — the pass takes priority,
 * never stacks).
 */
export function computeBogoScheduledFree(
  items: Array<{
    kind: string;
    date?: string | null;
    packageIdAdult?: string | null;
    packageIdJunior?: string | null;
    heats?: RaceHeatAssignment[];
  }>,
  party: Array<{ id: string; memberships?: string[] }>,
  alreadyCovered: ReadonlySet<RaceHeatAssignment>,
  now: Date = new Date(),
): BogoScheduledFree {
  const heats = new Set<RaceHeatAssignment>();
  const freeByMember = new Map<string, number>();
  // Racers whose pass pricing wins over the special (owner: never combined).
  const passBlocked = new Set(
    party.filter((m) => racingPassBlocksBogo(m.memberships)).map((m) => m.id),
  );

  for (const item of items) {
    if (item.kind !== "race" || !item.heats || !item.date) continue;
    if (!bogoSaleActive(item.date, now)) continue;

    // Collect each racer's PAIRABLE heats for this item, in session order.
    const byMember = new Map<string, RaceHeatAssignment[]>();
    for (const h of item.heats) {
      if (!h.heatId || !h.assignedTo) continue;
      if (passBlocked.has(h.assignedTo)) continue;
      // Premium bundles price their own races — per CATEGORY, so an adult
      // package never blocks the junior side's singles (computePackCoverage
      // parity).
      const heatPkg =
        (h.category ?? "adult") === "junior" ? item.packageIdJunior : item.packageIdAdult;
      if (heatPkg) continue;
      if (alreadyCovered.has(h)) continue;
      // Booked multi-race pack products are already bundle-priced.
      if (getRaceProductById(h.productId)?.packType === "combo") continue;
      const list = byMember.get(h.assignedTo) ?? [];
      list.push(h);
      byMember.set(h.assignedTo, list);
    }

    // Pair consecutively; free the cheaper of each complete pair (tie → the
    // later heat). An unresolvable price reads 0 — it then counts as the
    // "cheaper" side, which can only under-discount, never over-discount.
    for (const [memberId, list] of byMember) {
      for (let i = 0; i + 1 < list.length; i += 2) {
        const a = list[i];
        const b = list[i + 1];
        const priceOf = (h: RaceHeatAssignment) => getRaceProductById(h.productId)?.price ?? 0;
        const free = priceOf(a) < priceOf(b) ? a : b;
        heats.add(free);
        freeByMember.set(memberId, (freeByMember.get(memberId) ?? 0) + 1);
      }
    }
  }
  return { heats, freeByMember };
}
