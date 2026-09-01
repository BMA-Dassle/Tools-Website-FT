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
  /** 0 = OPTIONAL. Comes from the per-ITEM override, not the list's own value. */
  minSelected?: number;
  /** null / undefined = unlimited. */
  maxSelected?: number | null;
  options: Array<{ id: string; name: string; priceCents?: number }>;
}

/** Does this group have to be answered before the guest can continue? */
export function isRequired(g: ModifierGroup): boolean {
  return (g.minSelected ?? 0) > 0;
}

/** How many picks this group still accepts, or null for unlimited. */
export function remainingPicks(g: ModifierGroup, chosen: number): number | null {
  if (g.selectionType === "SINGLE") return Math.max(0, 1 - chosen);
  const max = g.maxSelected ?? null;
  return max == null ? null : Math.max(0, max - chosen);
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
 * POOLED across the item's groups, not counted per group. That is not the
 * obvious choice, so: the real Pizza Bowl pizza carries TWO lists — a SINGLE
 * "One included Topping" and a MULTIPLE "Pizza Toppings" for paid extras — and
 * together they express ONE allowance of one topping. Counting per group gives
 * each list its own free pick, so 1 included + 2 extras bills $1 instead of $2.
 *
 * The old hardcoded step pooled (`countToppings` summed every non-drink group
 * and subtracted a single free count), and pooling is what keeps this
 * behaviourally identical. Verified against the live catalog 2026-08-31.
 *
 * An item whose groups are genuinely independent (NFL wings: heat + dressing)
 * is unaffected, because it charges nothing for extras at all.
 */
export function extraPicksForLane(food: FoodItem, sel: LaneSelections): number {
  const picked = food.groups.reduce((n, g) => n + (sel[g.id] ?? []).length, 0);
  return Math.max(0, picked - food.includedModifierCount);
}

/**
 * What one selected OPTION costs, from Square's own modifier price.
 *
 * Distinct from the item-level allowance rule below. Two different things are
 * chargeable and both are real: the pizza's "$1 per topping beyond the first"
 * is OUR rule (Square lists those toppings at zero), while "All Drums +$2" and
 * "extra sauce +75c" are prices Square itself carries on the option. Summing
 * only one of them would undercharge.
 */
export function optionCentsForLane(foodItems: readonly FoodItem[], sel: LaneSelections): number {
  let cents = 0;
  for (const food of foodItems) {
    for (const g of food.groups) {
      for (const id of sel[g.id] ?? []) {
        cents += g.options.find((o) => o.id === id)?.priceCents ?? 0;
      }
    }
  }
  return cents;
}

/** What the guest owes for extras on one lane, across all food items. */
export function extraCentsForLane(foodItems: readonly FoodItem[], sel: LaneSelections): number {
  const allowance = foodItems.reduce(
    (cents, food) =>
      cents +
      (food.extraModifierCents > 0 ? extraPicksForLane(food, sel) * food.extraModifierCents : 0),
    0,
  );
  return allowance + optionCentsForLane(foodItems, sel);
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
 * Optional groups are simply absent from `requiredGroupIds` — the route now
 * carries Square's per-item `min_selected_modifiers`, so "Drums or Flats" and
 * "extra sauce" can sit on the wings without trapping a guest who wants
 * neither. (Before 2026-08-31 the min was not plumbed through and EVERY
 * attached list was required, which is why the wings could only carry two.)
 */
export function foodSelectionIssue(args: {
  /** Only groups the guest MUST answer — an optional group belongs nowhere near
   *  this list, or it traps them on the step. */
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
      return lanes > 1
        ? "Pick an option in every group, for every lane"
        : "Pick an option in every group";
    }
  }
  return null;
}
