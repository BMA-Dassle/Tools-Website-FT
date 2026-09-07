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

/** The slice of a `bowling_experience_items` row the food rules read. */
export interface ConfigurableFoodItemLike {
  priceCents: number;
  /** Optional on the client line-builder shapes; absent = nothing to configure. */
  squareCatalogObjectId?: string | null;
  /**
   * Picks the package INCLUDES for this item — and therefore the picks the
   * guest MUST make. Optional only because older client shapes omit it; a
   * missing value reads as 0 (not configurable).
   */
  includedModifierCount?: number;
}

/**
 * Is this experience item food the GUEST configures?
 *
 * Three things must be true: it is $0 (a package's PRICED item is the lane
 * time itself; the $0 entries are the bundled extras), it has a Square catalog
 * id to hang modifier groups off, and the package includes at least one pick on
 * it. That last test is what separates the Pizza Bowl pizza (pick a topping)
 * from the VIP chips & salsa ($0, on the ticket, nothing to choose): the chips
 * ride the ordinary line items, the pizza rides `rawItems` with the guest's
 * choices as its note. An item must travel ONE of those two ways, never both —
 * a $0 line already on the pre-created day-of order makes the reserve rail
 * skip the noted copy as "already attached", and the toppings are lost.
 */
export function isGuestConfiguredFood(item: ConfigurableFoodItemLike): boolean {
  return (
    item.priceCents === 0 && !!item.squareCatalogObjectId && (item.includedModifierCount ?? 0) > 0
  );
}

/** Which experience items are configurable food? See `isGuestConfiguredFood`. */
export function configurableFoodItems<T extends ConfigurableFoodItemLike>(
  items: readonly T[] | null | undefined,
): T[] {
  return (items ?? []).filter(isGuestConfiguredFood);
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

/**
 * The picker for a BOOKED order: only what the package includes.
 *
 * Owner 2026-09-06: post-booking edits (confirmation page, open-lane, admin)
 * must never add money to the bill — "just do the required included". So the
 * priced options go (the +$2 bacon on the paid toppings list, +$2 drums), and a
 * list left with nothing $0 on it goes with them. What remains is exactly the
 * set of picks the package already paid for. The server enforces the same rule
 * by refusing any edit whose extras total is not zero.
 */
export function withoutPaidOptions(foodItems: readonly FoodItem[]): FoodItem[] {
  return foodItems.map((f) => ({
    ...f,
    groups: f.groups
      .map((g) => ({ ...g, options: g.options.filter((o) => (o.priceCents ?? 0) === 0) }))
      .filter((g) => g.options.length > 0),
  }));
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
 * The "why Continue is blocked" strings, exported so the kiosk can map each
 * one to a translated message key (canAdvance runs at module scope and cannot
 * reach useT). Change one here and the kiosk map follows by reference.
 */
export const FOOD_REASON = {
  notLoaded: "Hang on — loading your package's food choices",
  unavailable: "We couldn't load the food choices for this package — tap Retry",
  pickEveryGroup: "Make every included pick before you continue",
  pickEveryLane: "Make every included pick, for every lane",
} as const;

/** How many picks the guest has made across ALL of one item's groups. */
export function itemPicksForLane(food: FoodItem, sel: LaneSelections): number {
  return food.groups.reduce((n, g) => n + (sel[g.id] ?? []).length, 0);
}

/**
 * Included picks the guest still owes on one item — the ITEM-level rule.
 *
 * The package says how many picks it includes (`includedModifierCount`), and
 * an included pick is a pick the kitchen needs an answer to: a one-topping
 * pizza with no topping named is not an order, it is a question. So the guest
 * must take at least that many picks across the item's groups. ("No Topping"
 * and "No beverage" are options on the real lists, so declining is still a
 * pick — the kitchen just knows it was deliberate.)
 *
 * This deliberately does NOT depend on Square's per-item minimums. On the live
 * Pizza Bowl items those are unset (-1), which the route reads as optional —
 * exactly the reading that let a Pizza Bowl book with no pizza and no drink
 * (2026-09-06). Our config is the authority on what the package includes;
 * Square's minimums are honoured on top of it, never instead of it.
 */
export function includedPicksOwed(food: FoodItem, sel: LaneSelections): number {
  return Math.max(0, food.includedModifierCount - itemPicksForLane(food, sel));
}

/** Groups on one item that Square itself marks required and that lack picks. */
export function unansweredRequiredGroups(food: FoodItem, sel: LaneSelections): ModifierGroup[] {
  return food.groups.filter(
    (g) => isRequired(g) && (sel[g.id]?.length ?? 0) < (g.minSelected ?? 1),
  );
}

/** Is ONE lane's food fully answered? Both rules: Square's group minimums and
 *  the package's included-pick count, on every item. */
export function laneFoodComplete(foodItems: readonly FoodItem[], sel: LaneSelections): boolean {
  return foodItems.every(
    (f) => unansweredRequiredGroups(f, sel).length === 0 && includedPicksOwed(f, sel) === 0,
  );
}

/**
 * Can the guest continue?
 *
 * Fails CLOSED. `foodItems` undefined means the catalog has not loaded (or
 * failed to) — the guest waits or retries; it never means "skip the food".
 * An EMPTY list is also a block: this step only renders for packages that
 * bundle configurable food (the slug gate in BowlingFoodStep), so a package
 * that loads zero configurable items is misconfigured, not food-free — and a
 * Pizza Bowl booked without a pizza is the incident this replaces. Before
 * 2026-09-06 both cases passed the guest through ("a Square hiccup must never
 * trap a booking"), and the Pizza Bowl experiences had never been seeded with
 * their $0 pizza and soda items, so every booking took the hiccup path: 35 of
 * ~55 Pizza Bowls on 9/6 reached the kitchen with no food on the order. A
 * blocked step is loud and gets fixed within the hour; a silent skip loses a
 * day of orders.
 */
export function foodSelectionIssue(args: {
  /** undefined = not loaded yet; [] = loaded, nothing configurable (misconfig). */
  foodItems: readonly FoodItem[] | null | undefined;
  selections: readonly LaneSelections[];
  laneCount: number;
}): string | null {
  const { foodItems, selections, laneCount } = args;
  if (!foodItems) return FOOD_REASON.notLoaded;
  if (foodItems.length === 0) return FOOD_REASON.unavailable;
  const lanes = Math.max(1, laneCount);
  for (let lane = 0; lane < lanes; lane++) {
    if (!laneFoodComplete(foodItems, selections[lane] ?? {})) {
      return lanes > 1 ? FOOD_REASON.pickEveryLane : FOOD_REASON.pickEveryGroup;
    }
  }
  return null;
}

/**
 * SERVER-SIDE backstop: does the booking carry every configured food line?
 *
 * The client gate above is what failed for three months, so the rails check
 * too — the day-of Square order MUST carry the pizza and the drink, with the
 * guest's choices in the note (owner 2026-09-06). Reads only our own config
 * (the experience's items), no Square round-trip: for every guest-configured
 * item there must be EXACTLY `laneCount` `rawItems` lines for it, each with a
 * non-empty note. Exactly, not at-least — a party that dropped from two lanes
 * to one with stale lane-2 lines would otherwise order two pizzas for one lane.
 *
 * Returns a guest-readable reason, or null when the booking is complete.
 */
export function missingRequiredFoodLines(args: {
  items: readonly (ConfigurableFoodItemLike & { label: string })[] | null | undefined;
  laneCount: number;
  rawItems: readonly { catalogObjectId: string; note?: string }[] | null | undefined;
}): string | null {
  const lanes = Math.max(1, Math.round(args.laneCount || 1));
  const raw = args.rawItems ?? [];
  const problems: string[] = [];
  for (const food of configurableFoodItems(args.items)) {
    const lines = raw.filter((ri) => ri.catalogObjectId === food.squareCatalogObjectId);
    const noted = lines.filter((ri) => (ri.note ?? "").trim().length > 0);
    if (lines.length !== lanes || noted.length !== lanes) problems.push(food.label);
  }
  if (problems.length === 0) return null;
  const what = problems.join(" and ");
  return lanes > 1
    ? `Your package includes ${what} — pick the options for every lane before booking.`
    : `Your package includes ${what} — pick the options before booking.`;
}

/** Thrown by the unified rail's fail-closed food guard (→ 409 in reserve-all). */
export class PackageFoodMissingError extends Error {
  readonly code = "package_food_missing";
  constructor(message: string) {
    super(message);
    this.name = "PackageFoodMissingError";
  }
}
