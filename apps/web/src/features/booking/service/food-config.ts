/**
 * Configurable package food — pure logic, no React, no fetching.
 *
 * A bowling package can bundle $0 items the guest configures: the Pizza Bowl
 * pizza and soda pitcher today, NFL game-day wings/pizza/pitcher next. Each
 * such item carries Square modifier groups ("Pizza Toppings", "Soda Choice",
 * "Wing Heat", "Dressing") and the guest's picks ride the booking as `rawItems`
 * → the Square day-of order (so the ticket reaches the kitchen KDS) AND
 * `bowling_reservation_lines` (so our DB owns the data — see reservation-lines.ts).
 *
 * WHY THIS EXISTS. BowlingFoodStep used to hardcode two Square catalog ids, a
 * `/soda|drink|pitcher/i` regex to guess which group was the drink, and a
 * module-const "1 free topping, $1 extra". Adding a second package would have
 * meant a third hardcode. Config now comes off `bowling_experience_items`
 * (`included_modifier_count`, `extra_modifier_cents`), which means a new package
 * is a seed row rather than a component edit — and the logic is unit-testable
 * rather than trapped in a component.
 *
 * SELECTION STATE. `pizzaModifierSelections` is one entry per LANE, keyed by
 * Square modifier-group id. The name is legacy (it predates any package but
 * Pizza Bowl); renaming it would force a persisted-session schema bump for no
 * behavioural gain, so it stays. Group ids are globally unique in Square, so one
 * flat map per lane addresses every group across every food item.
 */

/** A Square modifier group as the catalog-modifiers route returns it. */
export interface ModifierGroup {
  id: string;
  name: string;
  selectionType: "SINGLE" | "MULTIPLE";
  options: Array<{ id: string; name: string }>;
}

/** One configurable $0 package item, plus the groups Square hangs off it. */
export interface FoodItem {
  catalogObjectId: string;
  /** Label shown to the guest and written into the Square line / Neon label. */
  name: string;
  includedModifierCount: number;
  extraModifierCents: number;
  groups: ModifierGroup[];
}

/** Per-lane selections: group id → chosen option ids. */
export type LaneSelections = Record<string, string[]>;

/**
 * Which experience items are configurable food?
 *
 * The $0 ones. A package's PRICED item is the lane time itself (and shoes, when
 * they are included); the $0 entries are the bundled extras, and only those can
 * carry modifier groups. Deliberately not keyed on product_kind or a slug —
 * price is the honest signal and needs no new taxonomy.
 */
export function configurableFoodItems<
  T extends { priceCents: number; squareCatalogObjectId: string },
>(items: readonly T[] | null | undefined): T[] {
  return (items ?? []).filter((i) => i.priceCents === 0 && !!i.squareCatalogObjectId);
}

/** Every group across every food item, in item then group order. */
export function allGroups(foodItems: readonly FoodItem[]): ModifierGroup[] {
  return foodItems.flatMap((f) => f.groups);
}

/**
 * Apply one tap. SINGLE groups replace (and tapping the chosen option clears
 * it); MULTIPLE groups toggle. Returns a NEW array — never mutates.
 */
export function toggleSelection(args: {
  selections: readonly LaneSelections[];
  laneIndex: number;
  groupId: string;
  optionId: string;
  selectionType: "SINGLE" | "MULTIPLE";
}): LaneSelections[] {
  const { selections, laneIndex, groupId, optionId, selectionType } = args;
  const next = [...selections];
  const lane: LaneSelections = { ...(next[laneIndex] ?? {}) };
  const current = lane[groupId] ?? [];
  lane[groupId] =
    selectionType === "SINGLE"
      ? current.includes(optionId)
        ? []
        : [optionId]
      : current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId];
  next[laneIndex] = lane;
  return next;
}

/** Option ids → their display names, in the group's own order. */
function namesFor(group: ModifierGroup, chosen: readonly string[]): string[] {
  return group.options.filter((o) => chosen.includes(o.id)).map((o) => o.name);
}

/**
 * Build the `rawItems` the reserve rails send to Square and persist to Neon.
 *
 * One line per food item per lane. The note carries the guest's picks for THAT
 * item only — grouping by item is what makes a wings order say "Mild, Ranch"
 * instead of smearing every choice across every line. Multi-lane parties get a
 * `Lane N: ` prefix, matching the existing Pizza Bowl output exactly.
 */
export function buildFoodRawItems(args: {
  foodItems: readonly FoodItem[];
  selections: readonly LaneSelections[];
  laneCount: number;
}): Array<{ catalogObjectId: string; name: string; quantity: number; note?: string }> {
  const { foodItems, selections, laneCount } = args;
  const lanes = Math.max(1, laneCount);
  const out: Array<{ catalogObjectId: string; name: string; quantity: number; note?: string }> = [];
  for (let lane = 0; lane < lanes; lane++) {
    const sel = selections[lane] ?? {};
    const prefix = lanes > 1 ? `Lane ${lane + 1}: ` : "";
    for (const food of foodItems) {
      const picks = food.groups.flatMap((g) => namesFor(g, sel[g.id] ?? [])).join(", ");
      out.push({
        catalogObjectId: food.catalogObjectId,
        name: food.name,
        quantity: 1,
        ...(picks ? { note: `${prefix}${picks}` } : {}),
      });
    }
  }
  return out;
}

/**
 * Picks beyond what a food item includes, for one lane.
 *
 * Counted PER GROUP, not pooled across them. Pooling would let a guest take
 * nothing from one group and two free picks from another — for a single-group
 * item like the Pizza Bowl pizza the two are identical, but the per-group rule
 * is the one that stays correct when an item carries several groups (NFL wings:
 * heat + dressing).
 */
export function extraPicksForLane(food: FoodItem, sel: LaneSelections): number {
  return food.groups.reduce(
    (n, g) => n + Math.max(0, (sel[g.id] ?? []).length - food.includedModifierCount),
    0,
  );
}

/** What the guest owes for extras on one lane, across all food items. */
export function extraCentsForLane(foodItems: readonly FoodItem[], sel: LaneSelections): number {
  return foodItems.reduce(
    (cents, food) =>
      cents + (food.extraModifierCents > 0 ? extraPicksForLane(food, sel) * food.extraModifierCents : 0),
    0,
  );
}

/** Total extras charge across every lane. */
export function extraCentsTotal(args: {
  foodItems: readonly FoodItem[];
  selections: readonly LaneSelections[];
  laneCount: number;
}): number {
  const lanes = Math.max(1, args.laneCount);
  let cents = 0;
  for (let lane = 0; lane < lanes; lane++) {
    cents += extraCentsForLane(args.foodItems, args.selections[lane] ?? {});
  }
  return cents;
}

/**
 * Can the guest continue? Every group needs at least one pick, on every lane.
 *
 * Fails OPEN when nothing loaded — a Square hiccup must never trap a booking
 * mid-wizard, which is why `requiredGroupIds` is recorded only once the fetch
 * succeeds.
 *
 * Caveat worth knowing: the catalog-modifiers route does not surface Square's
 * `min_selected_modifiers`, so an OPTIONAL group would be wrongly required.
 * Every group on every package to date is a required choice (topping, drink,
 * heat, dressing). Plumb the min through before shipping an optional one.
 */
export function foodSelectionIssue(args: {
  requiredGroupIds: readonly string[];
  selections: readonly LaneSelections[];
  laneCount: number;
}): string | null {
  const { requiredGroupIds, selections, laneCount } = args;
  if (requiredGroupIds.length === 0) return null;
  const lanes = Math.max(1, laneCount);
  for (let lane = 0; lane < lanes; lane++) {
    const sel = selections[lane] ?? {};
    const missing = requiredGroupIds.some((gid) => (sel[gid]?.length ?? 0) === 0);
    if (missing) {
      return lanes > 1 ? "Pick an option in every group, for every lane" : "Pick an option in every group";
    }
  }
  return null;
}
