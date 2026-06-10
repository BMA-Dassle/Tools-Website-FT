/**
 * Combo-specials pricing override — the single source of truth for what a
 * combo session charges.
 *
 * `comboChargeLines(session)` returns the combo's Square charge lines when
 * the session is a valid combo (strict gate), or null to fall back to normal
 * item-sum pricing. It is consumed by `buildRaceChargeLines` (checkout.ts),
 * which ALREADY feeds the checkout review (buildZeroModelOverview), the cash
 * path (buildCombinedLineItems), and the credit path — so display == charge
 * by construction, one seam.
 *
 * Money invariants (tasks/combo-specials-plan.md):
 *   - The combo line lives ONLY on Square. BMI heats stay $0 (zero model);
 *     the QAMF bowling reservation is created/confirmed but its line items
 *     are NOT separately charged (callers suppress them when the gate
 *     passes — see buildCombinedLineItems + CheckoutStep).
 *   - 100% of the combo price charges at booking (locked decision #7).
 *   - Per-PERSON price × distinct racers; membership discounts split per
 *     racer exactly like splitByDiscount (full-price line first).
 *   - Race credits do NOT combine with combo pricing (flat price).
 */

import type { BillLine } from "~/features/booking/service/checkout";
import { membershipDiscountsForNames } from "~/features/booking/service/membership-discounts";
import type { BookingSession, BowlingItem, RaceItem } from "~/features/booking/state/types";

import {
  comboAvailableOn,
  comboBowlingComponent,
  comboPriceCentsForDate,
  comboRaceComponent,
  getComboSpecial,
  type ComboSpecial,
} from "./combo-specials";

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ActiveCombo {
  combo: ComboSpecial;
  raceItem: RaceItem;
  bowlingItem: BowlingItem;
  /** Distinct racer ids (PartyMember.id) on the race heats. */
  racerIds: string[];
}

/**
 * STRICT gate: the combo price applies ONLY when exactly the combo's
 * components are present and complete. Anything else returns null and the
 * session prices as the sum of its items (the safe fallback — never a flat
 * price for a cart that doesn't match the offer).
 */
export function activeComboSpecial(session: BookingSession): ActiveCombo | null {
  const id = session.comboSpecialId;
  if (!id) return null;
  const combo = getComboSpecial(id);
  if (!combo || !combo.enabled) return null;
  if (session.center !== combo.center) return null;

  const raceComp = comboRaceComponent(combo);
  const bowlComp = comboBowlingComponent(combo);
  if (!raceComp || !bowlComp) return null;

  // Exactly ONE race item + ONE bowling item; KBF never mixes with a combo.
  // Extra ATTRACTION items are allowed — they charge separately on top.
  const raceItems = session.items.filter((i): i is RaceItem => i.kind === "race");
  const bowlingItems = session.items.filter((i): i is BowlingItem => i.kind === "bowling");
  const hasKbf = session.items.some((i) => i.kind === "kbf");
  if (raceItems.length !== 1 || bowlingItems.length !== 1 || hasKbf) return null;
  const raceItem = raceItems[0];
  const bowlingItem = bowlingItems[0];

  // Race side: a date, every heat picked + assigned, and EXACTLY raceCount
  // heats per racer (any tier/track — locked decision #5).
  if (!raceItem.date || !comboAvailableOn(combo, raceItem.date)) return null;
  if (raceItem.heats.length === 0) return null;
  const perRacer = new Map<string, number>();
  for (const h of raceItem.heats) {
    if (!h.heatId || !h.assignedTo) return null;
    perRacer.set(h.assignedTo, (perRacer.get(h.assignedTo) ?? 0) + 1);
  }
  for (const count of perRacer.values()) {
    if (count !== raceComp.raceCount) return null;
  }

  // Bowling side: a booked slot at exactly the combo's duration.
  if (!bowlingItem.bookedAt) return null;
  if (bowlingItem.durationMinutes !== bowlComp.durationMinutes) return null;

  return { combo, raceItem, bowlingItem, racerIds: [...perRacer.keys()] };
}

/** Highest racing membership discount (%) + label for a racer — mirrors
 *  checkout.ts `racingDiscountForMember` so combo split lines group racers
 *  identically to race split lines. */
function discountForRacer(
  session: BookingSession,
  racerId: string,
): { percent: number; label: string | null } {
  const member = session.party.find((p) => p.id === racerId);
  if (!member?.memberships?.length) return { percent: 0, label: null };
  let percent = 0;
  let label: string | null = null;
  for (const d of membershipDiscountsForNames(member.memberships)) {
    if (d.categories.includes("racing") && d.percentOff > percent) {
      percent = d.percentOff;
      label = d.label;
    }
  }
  return { percent, label };
}

/**
 * The combo's Square charge lines — ONE line per racer-discount-group at the
 * per-person price for the race date — or null when the gate doesn't pass.
 * Suppresses nothing itself: callers replace the per-item race product lines
 * and the bowling line items with this. License + POV still charge on top
 * (they're not combo components).
 */
export function comboChargeLines(session: BookingSession): BillLine[] | null {
  const active = activeComboSpecial(session);
  if (!active) return null;
  const { combo, raceItem, racerIds } = active;

  const unit = comboPriceCentsForDate(combo, raceItem.date!) / 100;
  const earliestHeat = raceItem.heats
    .map((h) => h.heatId)
    .filter((s): s is string => !!s)
    .sort()[0];

  // Group racers by their racing discount %, full-price group first —
  // identical naming + split semantics to checkout.ts splitByDiscount.
  const groups = new Map<number, { label: string | null; count: number }>();
  for (const racerId of racerIds) {
    const { percent, label } = discountForRacer(session, racerId);
    const g = groups.get(percent) ?? { label, count: 0 };
    g.count += 1;
    groups.set(percent, g);
  }

  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([percent, g]) => {
      const base = unit * g.count;
      return {
        name: percent > 0 ? `${combo.name} (${g.label ?? "Member"} −${percent}%)` : combo.name,
        quantity: g.count,
        amount: round2(percent > 0 ? base * (1 - percent / 100) : base),
        time: earliestHeat,
        ...(percent > 0 ? { membershipDiscountPct: percent } : {}),
      };
    });
}
