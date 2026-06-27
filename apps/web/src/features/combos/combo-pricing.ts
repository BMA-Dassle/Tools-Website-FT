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
import { promoFactor } from "~/features/booking/service/promo-pricing";
import { scheduleForDate } from "~/features/booking/service/race-pricing";
import type { BookingSession, BowlingItem, RaceItem } from "~/features/booking/state/types";
import type { DiscountDomain } from "~/features/discount-codes";

import { wallClockMs } from "./combo-itinerary";
import {
  comboAvailableOn,
  comboBowlingComponent,
  comboPriceCentsForDate,
  comboRaceLegs,
  getComboSpecial,
  type ComboEntity,
  type ComboLeg,
  type ComboRevenueLine,
  type ComboSpecial,
} from "./combo-specials";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Combo line → discount-codes domain for promo eligibility (USA250 covers both). */
function entityToDomain(entity: ComboEntity): DiscountDomain {
  return entity === "headpinz-fm" ? "bowling" : "racing";
}

export interface ActiveCombo {
  combo: ComboSpecial;
  raceItem: RaceItem;
  bowlingItem: BowlingItem;
  /** Distinct racer ids (PartyMember.id) on the race heats. */
  racerIds: string[];
}

/**
 * STRICT gate: the combo price applies ONLY when exactly the combo's
 * itinerary is present and complete. Anything else returns null and the
 * session prices as the sum of its items (the safe fallback — never a flat
 * price for a cart that doesn't match the offer).
 *
 * Generic over the registry legs (Revision 2): per racer, one heat per race
 * leg whose TIERS run in itinerary order, and the bowling slot positioned
 * between the race legs that surround it. The wizard enforces real buffers;
 * this gate re-checks the STRUCTURE at charge time.
 */
export function activeComboSpecial(session: BookingSession): ActiveCombo | null {
  const id = session.comboSpecialId;
  if (!id) return null;
  const combo = getComboSpecial(id);
  if (!combo || !combo.enabled) return null;
  if (session.center !== combo.center) return null;

  const legs = combo.components;
  const raceLegs = comboRaceLegs(combo);
  const bowlComp = comboBowlingComponent(combo);
  // Attraction legs are forward-compat only — never flat-price a cart whose
  // itinerary the wizard can't actually assemble yet.
  if (legs.some((l) => l.kind === "attraction")) return null;
  if (raceLegs.length === 0 || !bowlComp) return null;
  if (legs.filter((l) => l.kind === "bowling").length !== 1) return null;

  // Exactly ONE race item + ONE bowling item; KBF never mixes with a combo.
  // Extra ATTRACTION items are allowed — they charge separately on top.
  const raceItems = session.items.filter((i): i is RaceItem => i.kind === "race");
  const bowlingItems = session.items.filter((i): i is BowlingItem => i.kind === "bowling");
  const hasKbf = session.items.some((i) => i.kind === "kbf");
  if (raceItems.length !== 1 || bowlingItems.length !== 1 || hasKbf) return null;
  const raceItem = raceItems[0];
  const bowlingItem = bowlingItems[0];

  if (!raceItem.date || !comboAvailableOn(combo, raceItem.date)) return null;
  if (raceItem.heats.length === 0) return null;

  // Bowling side first: a booked slot at exactly the combo's duration, on
  // the leg's tier (a VIP combo must actually hold a VIP lane).
  if (!bowlingItem.bookedAt) return null;
  if (bowlingItem.durationMinutes !== bowlComp.durationMinutes) return null;
  if (bowlComp.vip && bowlingItem.tier !== "vip") return null;
  const bowlingMs = wallClockMs(bowlingItem.bookedAt);

  // Race side: every heat picked + assigned; per racer one heat per race leg.
  const byRacer = new Map<string, Array<{ ms: number; tier: string | undefined }>>();
  for (const h of raceItem.heats) {
    if (!h.heatId || !h.assignedTo) return null;
    const list = byRacer.get(h.assignedTo) ?? [];
    list.push({ ms: wallClockMs(h.heatId), tier: h.tier });
    byRacer.set(h.assignedTo, list);
  }
  if (byRacer.size === 0) return null;

  // A booking is a valid combo if it matches the primary ordering OR (when the
  // combo defines one) the reorder fallback ordering. Each ordering check: per
  // racer, heats sorted by time have the ordering's race-leg tiers in sequence,
  // each positioned on the correct side of the lane. The normal order brackets
  // the lane (race → bowl → race); the fallback runs both races first
  // (race → race → bowl). Without trying the fallback, a reordered booking
  // would miss the gate and (wrongly) price à la carte.
  const matchesOrdering = (legs: ComboLeg[]): boolean => {
    const bowlingLegIndex = legs.findIndex((l) => l.kind === "bowling");
    if (bowlingLegIndex < 0) return false;
    const raceLegOrder = legs
      .map((leg, i) => ({ leg, i }))
      .filter(
        (e): e is { leg: Extract<ComboLeg, { kind: "race" }>; i: number } => e.leg.kind === "race",
      );
    if (raceLegOrder.length !== raceLegs.length) return false;
    for (const heats of byRacer.values()) {
      if (heats.length !== raceLegs.length) return false;
      const sorted = [...heats].sort((a, b) => a.ms - b.ms);
      for (let k = 0; k < raceLegOrder.length; k++) {
        const { leg, i } = raceLegOrder[k];
        const h = sorted[k];
        if (h.tier !== leg.tier) return false;
        if (i < bowlingLegIndex && h.ms >= bowlingMs) return false;
        if (i > bowlingLegIndex && h.ms <= bowlingMs) return false;
      }
    }
    return true;
  };
  const orderings = [
    combo.components,
    ...(combo.fallbackComponents ? [combo.fallbackComponents] : []),
  ];
  if (!orderings.some(matchesOrdering)) return null;

  return { combo, raceItem, bowlingItem, racerIds: [...byRacer.keys()] };
}

/* ── Itemized revenue split (Model A) ─────────────────────────────────── */

/** One itemized combo line, routed to an entity's Square day-of order. */
export interface ComboItemLine {
  key: string;
  name: string;
  entity: ComboEntity;
  catalogObjectId: string;
  quantity: number;
  /** Per-unit cents (after license reallocation AND any USA250 reduction). */
  unitCents: number;
  /** Pre-promo per-unit cents, set only when a promo reduced this line — lets
   *  comboChargeLines stamp the BillLine's `originalAmount` for the strikethrough. */
  originalUnitCents?: number;
}

/**
 * Itemize the combo's flat per-person price into per-line, per-entity charge
 * lines from the registry `revenueSplit`. Returns null when the gate fails OR
 * the combo has no revenueSplit (caller flat-prices instead).
 *
 * Computed per racer then aggregated by (line, unit cents), so new vs
 * returning racers (license reallocation) collapse into the right quantities.
 * NO membership discount is applied — the combo IS a fixed promotional bundle;
 * stacking an employee/league discount on top is intentionally not supported
 * (book à la carte for that). Sums to exactly the flat per-person price.
 *
 * EXCEPTION — the USA250 holiday promo (owner decision: combos DO get it).
 * It is a separate, code-driven price-key reduction (not a membership discount),
 * applied here on the SHARED itemized seam so it flows to BOTH comboChargeLines
 * (display) AND comboOrderGroups (the two split day-of orders) consistently.
 */
export function comboItemizedLines(session: BookingSession): ComboItemLine[] | null {
  const active = activeComboSpecial(session);
  if (!active) return null;
  const { combo, raceItem, racerIds } = active;
  const split = combo.revenueSplit;
  if (!split || split.length === 0) return null;

  const weekend = scheduleForDate(raceItem.date!) === "weekend";
  const cents = (l: ComboRevenueLine) => (weekend ? l.weekendCents : l.weekdayCents);
  const byKey = new Map(split.map((l) => [l.key, l] as const));
  const isNew = (rid: string) => !!session.party.find((p) => p.id === rid)?.isNewRacer;

  // (lineKey, unitCents) → aggregated quantity.
  const agg = new Map<string, { line: ComboRevenueLine; unitCents: number; qty: number }>();
  for (const rid of racerIds) {
    const perLineCents = new Map<string, number>();
    for (const l of split) {
      const applies =
        l.appliesTo === "allRacers" || (l.appliesTo === "newRacersOnly" && isNew(rid));
      if (applies) {
        perLineCents.set(l.key, (perLineCents.get(l.key) ?? 0) + cents(l));
      } else if (l.reallocateTo) {
        // Skipped (e.g. returning racer's license) → roll onto the target line
        // so the per-person total stays exact.
        perLineCents.set(l.reallocateTo, (perLineCents.get(l.reallocateTo) ?? 0) + cents(l));
      }
    }
    for (const [key, c] of perLineCents) {
      const line = byKey.get(key);
      if (!line) continue;
      const aggKey = `${key}|${c}`;
      const e = agg.get(aggKey) ?? { line, unitCents: c, qty: 0 };
      e.qty += 1;
      agg.set(aggKey, e);
    }
  }

  const order = new Map(split.map((l, i) => [l.key, i] as const));
  return [...agg.values()]
    .sort(
      (a, b) =>
        (order.get(a.line.key) ?? 0) - (order.get(b.line.key) ?? 0) || a.unitCents - b.unitCents,
    )
    .map((e) => {
      // USA250: reduce the price key per line (entity → domain; the combo's
      // date gates the booking-date window). factor is 1 when ineligible.
      const factor = promoFactor(
        { domain: entityToDomain(e.line.entity), visitDate: raceItem.date },
        session.appliedPromo,
      );
      const unitCents = factor === 1 ? e.unitCents : Math.round(e.unitCents * factor);
      return {
        key: e.line.key,
        // The label IS the experience name now — each center's day-of order carries
        // ONE "Ultimate VIP Experience" line (license/POV/shoes folded in), not an
        // itemized parts list. (Pre-2026-06-23 this prefixed "VIP Exp - ".)
        name: e.line.label,
        entity: e.line.entity,
        catalogObjectId: e.line.catalogObjectId,
        quantity: e.qty,
        unitCents,
        ...(factor === 1 ? {} : { originalUnitCents: e.unitCents }),
      };
    });
}

/**
 * The combo's Square charge lines — ITEMIZED per the revenue split (races,
 * POV, license, VIP bowling, shoes), each tagged with its entity + catalog
 * variation so the reserve flow can route it to that entity's day-of order.
 * Falls back to ONE flat line when a combo has no revenueSplit. Null when the
 * gate doesn't pass (caller uses normal item-sum pricing).
 *
 * Consumed by buildRaceChargeLines → drives the checkout review (display) AND
 * the charge; comboOrderGroups regroups these by entity for the two orders, so
 * displayed == charged across both.
 */
export function comboChargeLines(session: BookingSession): BillLine[] | null {
  const active = activeComboSpecial(session);
  if (!active) return null;
  const { combo, raceItem, racerIds } = active;
  const earliestHeat = raceItem.heats
    .map((h) => h.heatId)
    .filter((s): s is string => !!s)
    .sort()[0];

  // USA250 % (for the strikethrough label); the actual reduction already
  // happened in comboItemizedLines (so the split orders inherit it).
  const promoPct = session.appliedPromo?.amountPct ?? undefined;

  const itemized = comboItemizedLines(session);
  if (itemized) {
    return itemized.map((l) => ({
      name: l.name,
      quantity: l.quantity,
      amount: round2((l.unitCents * l.quantity) / 100),
      time: earliestHeat,
      squareCatalogObjectId: l.catalogObjectId,
      comboEntity: l.entity,
      // Stamp the pre-promo total + % so the cart/review render the savings.
      // No `domain` is set: the reduction is fully owned by the combo seam, so
      // the generic applyPromoToBillLines in buildRaceChargeLines leaves these
      // alone (and the originalAmount guard double-protects reduced lines).
      ...(l.originalUnitCents != null
        ? { originalAmount: round2((l.originalUnitCents * l.quantity) / 100), promoPct }
        : {}),
    }));
  }

  // Legacy fallback: one flat combo line (combo without a revenueSplit).
  const unitFull = comboPriceCentsForDate(combo, raceItem.date!) / 100;
  const factor = promoFactor({ domain: "racing", visitDate: raceItem.date }, session.appliedPromo);
  const unit = factor === 1 ? unitFull : round2(unitFull * factor);
  return [
    {
      name: combo.name,
      quantity: racerIds.length,
      amount: round2(unit * racerIds.length),
      time: earliestHeat,
      ...(factor === 1 ? {} : { originalAmount: round2(unitFull * racerIds.length), promoPct }),
    },
  ];
}

/**
 * Group the combo's itemized lines by entity → one Square day-of order per
 * entity. Returns null when the gate fails or there's no revenueSplit (the
 * caller then creates a single order). Each group carries the lines to charge;
 * the reserve flow resolves the entity → Square location id + location tax,
 * creates the order, and the ONE shared gift card funds all groups.
 */
export interface ComboOrderGroup {
  entity: ComboEntity;
  lines: ComboItemLine[];
  subtotalCents: number;
}
export function comboOrderGroups(session: BookingSession): ComboOrderGroup[] | null {
  const itemized = comboItemizedLines(session);
  if (!itemized) return null;
  const byEntity = new Map<ComboEntity, ComboItemLine[]>();
  for (const l of itemized) {
    const arr = byEntity.get(l.entity) ?? [];
    arr.push(l);
    byEntity.set(l.entity, arr);
  }

  // Included $0 day-of items the VIP bowling EXPERIENCE carries (e.g. the
  // complimentary VIP Chips & Salsa) live on the bowling item's lineItems but
  // are NOT part of the registry revenueSplit, so the collapsed combo order
  // would otherwise DROP them — and the kitchen never fires the perk (standalone
  // VIP lanes keep it because they build the order from item.lineItems). Re-attach
  // every $0, catalog-linked bowling line to the bowling (HeadPinz) order. Because
  // they're $0 the totals/deposit and displayed==charged invariant are untouched,
  // and this self-syncs with whatever inclusions an experience defines (no
  // hard-coded catalog ids). Bowling is always HeadPinz in this codebase
  // (resolveLocationId / QAMF centers). See project_combo_date_drift_remediation
  // sibling fix + tasks/lessons.md.
  const active = activeComboSpecial(session);
  if (active) {
    const BOWLING_ENTITY: ComboEntity = "headpinz-fm";
    const bowlingLines = byEntity.get(BOWLING_ENTITY) ?? [];
    const seen = new Set(bowlingLines.map((l) => l.catalogObjectId));
    for (const li of active.bowlingItem.lineItems) {
      if ((li.priceCents ?? 0) !== 0 || !li.squareCatalogObjectId) continue;
      if (seen.has(li.squareCatalogObjectId)) continue;
      seen.add(li.squareCatalogObjectId);
      bowlingLines.push({
        key: `incl-${li.squareCatalogObjectId}`,
        name: li.label ?? "Included",
        entity: BOWLING_ENTITY,
        catalogObjectId: li.squareCatalogObjectId,
        quantity: li.quantity,
        unitCents: 0,
      });
    }
    if (bowlingLines.length > 0) byEntity.set(BOWLING_ENTITY, bowlingLines);
  }

  return [...byEntity.entries()].map(([entity, lines]) => ({
    entity,
    lines,
    subtotalCents: lines.reduce((s, l) => s + l.unitCents * l.quantity, 0),
  }));
}
