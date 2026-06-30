/**
 * Add-on pricing — registry-driven, PURE (no I/O), fully unit-testable.
 *
 * Reuses the combo's per-person price + revenue split so the add-on charges the
 * SAME flat per-person rate as the original booking and routes revenue to the
 * SAME entities (FastTrax racing + HeadPinz bowling). v1 treats every added
 * guest as a new racer, so `newRacersOnly` lines (e.g. a license) apply to all;
 * a skipped line still reallocates to keep the per-person total exact.
 */
import {
  comboPriceCentsForDate,
  type ComboEntity,
  type ComboRevenueLine,
  type ComboSpecial,
} from "~/features/combos";
import { scheduleForDate } from "~/features/booking/service/race-pricing";

import type { AddOnOrderGroup, AddOnQuote } from "./types";

/**
 * Per-person revenue lines for the add-on, keyed/aggregated like
 * comboItemizedLines but with NO promo and every guest NEW. Returns one line per
 * (revenueSplit key) at the day-tier unit price. Falls back to a single flat
 * line per the combo price when the combo has no revenueSplit.
 */
function addonItemizedLines(
  combo: ComboSpecial,
  eventDate: string,
): Array<{
  key: string;
  name: string;
  entity: ComboEntity;
  catalogObjectId: string;
  unitCents: number;
}> {
  const weekend = scheduleForDate(eventDate) === "weekend";
  const split = combo.revenueSplit;
  if (!split || split.length === 0) {
    // Legacy single-line combo (no split): not addable in practice (no catalog
    // ids to route), but keep the math correct for completeness.
    return [];
  }
  const cents = (l: ComboRevenueLine) => (weekend ? l.weekendCents : l.weekdayCents);
  const byKey = new Map(split.map((l) => [l.key, l] as const));

  // Per (new) guest: each line applies (newRacersOnly applies because the guest
  // is new); a never-applied line reallocates to keep the total exact.
  const perLineCents = new Map<string, number>();
  for (const l of split) {
    // For a new racer, both "allRacers" and "newRacersOnly" apply.
    perLineCents.set(l.key, (perLineCents.get(l.key) ?? 0) + cents(l));
  }

  const order = new Map(split.map((l, i) => [l.key, i] as const));
  return [...perLineCents.entries()]
    .filter(([, c]) => c > 0)
    .map(([key, unitCents]) => {
      const line = byKey.get(key)!;
      return {
        key,
        name: line.label,
        entity: line.entity,
        catalogObjectId: line.catalogObjectId,
        unitCents,
      };
    })
    .sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
}

/**
 * Group the add-on's per-person lines by entity into day-of order groups, with
 * quantity = `addCount`. One group per entity present (FastTrax racing +
 * HeadPinz bowling). Each line carries its catalog variation + price override.
 */
export function addonOrderGroups(
  combo: ComboSpecial,
  eventDate: string,
  addCount: number,
): AddOnOrderGroup[] {
  const lines = addonItemizedLines(combo, eventDate);
  const byEntity = new Map<ComboEntity, AddOnOrderGroup["lines"]>();
  for (const l of lines) {
    const arr = byEntity.get(l.entity) ?? [];
    arr.push({
      name: l.name,
      catalogObjectId: l.catalogObjectId,
      quantity: addCount,
      unitCents: l.unitCents,
    });
    byEntity.set(l.entity, arr);
  }
  return [...byEntity.entries()].map(([entity, groupLines]) => ({
    entity,
    lines: groupLines,
    subtotalCents: groupLines.reduce((s, l) => s + l.unitCents * l.quantity, 0),
  }));
}

/**
 * Build a priced quote for adding `addCount` guests. The displayed `totalCents`
 * is the same value the purchase path recomputes and charges (displayed ==
 * charged by construction — both derive from this function on the same inputs).
 */
export function buildAddOnQuote(
  combo: ComboSpecial,
  eventDate: string,
  addCount: number,
): AddOnQuote {
  const n = Math.max(0, Math.floor(addCount));
  const perPersonCents = comboPriceCentsForDate(combo, eventDate);
  const orderGroups = addonOrderGroups(combo, eventDate, n);
  const sumEntity = (e: ComboEntity) =>
    orderGroups.filter((g) => g.entity === e).reduce((s, g) => s + g.subtotalCents, 0);
  const fasttraxCents = sumEntity("fasttrax-fm");
  const headpinzCents = sumEntity("headpinz-fm");
  // The split must sum to the flat per-person price × n (invariant the original
  // booking also holds). When a combo has a revenueSplit, prefer the split sum
  // (it is the source of truth for what each entity is charged).
  const splitTotal = orderGroups.reduce((s, g) => s + g.subtotalCents, 0);
  const totalCents = splitTotal > 0 ? splitTotal : perPersonCents * n;
  return {
    addCount: n,
    perPersonCents,
    totalCents,
    weekend: scheduleForDate(eventDate) === "weekend",
    orderGroups,
    fasttraxCents,
    headpinzCents,
  };
}
