"use client";

/**
 * Package food configuration — "Customise your package".
 *
 * CONFIG-DRIVEN (2026-08-25) and REDESIGNED (2026-09-01). It used to hardcode
 * two Square catalog ids, guess the drink group with a `/soda|drink|pitcher/i`
 * regex over its NAME, and carry "1 free topping, $1 extra" as module consts.
 * Now the $0 items on the booked experience ARE the configurable food, each with
 * its own modifier groups and allowance, so a new package is a seed row. The
 * picker markup itself lives in FoodPicker (shared with the post-booking editor
 * and the open-lane gates); this file is loading, state and the gate.
 *
 * FAIL CLOSED (2026-09-06). The step used to pass the guest through when the
 * catalog did not load ("a Square hiccup must never trap a booking"), and the
 * Pizza Bowl experiences had never been seeded with their $0 pizza and soda
 * items — so EVERY Pizza Bowl took that path and reached the kitchen with no
 * food on the order (35 in one Sunday). Now: not loaded blocks, loaded-empty
 * blocks with a Retry, and the requirement to pick comes from OUR config (the
 * package includes N picks → the guest makes N picks) rather than Square's
 * per-item minimums, which are unset on the live Pizza Bowl items. The loaded
 * config is written onto the item (`foodItems`) so the module-scope
 * `canAdvance` gate can read it, and `rawItems` is rebuilt whenever the picks
 * OR the lane count change, so a party that grows or shrinks after this step
 * never books a stale food order.
 */

import { useEffect, useState } from "react";
import type { BowlingItem, StepDef } from "~/features/booking";
import type { BowlingExperienceWithDetails } from "@/lib/bowling-db";
import { QAMF_TO_CENTER_CODE } from "~/features/booking/service/bowling-hours";
import { useT } from "~/features/kiosk/i18n/useT";
import {
  buildFoodRawItems,
  configurableFoodItems,
  foodSelectionIssue,
  toggleSelection,
  type FoodItem,
  type ModifierGroup,
} from "~/features/booking/service/food-config";
import { FoodPicker } from "./FoodPicker";

// Bowling wizard accent — owner 2026-07-19: bowling reads BLUE.
const BLUE = "#00E2E5";

/** Load the package's configurable food + each item's Square modifier groups. */
async function loadFoodItems(experienceId: number, centerCode: string): Promise<FoodItem[]> {
  const expRes = await fetch(`/api/bowling/v2/experiences?centerCode=${centerCode}`);
  if (!expRes.ok) throw new Error(`experiences ${expRes.status}`);
  const exps: BowlingExperienceWithDetails[] = await expRes.json();
  const exp = Array.isArray(exps) ? exps.find((e) => e.id === experienceId) : undefined;
  const configurable = configurableFoodItems(exp?.items);
  // Per item, not merged — attributing a choice back to the item it belongs to
  // is what makes a wings line read "Mild, Ranch".
  const built = await Promise.all(
    configurable.map(async (ci): Promise<FoodItem> => {
      const res = await fetch(
        `/api/bowling/v2/catalog-modifiers?catalogObjectId=${ci.squareCatalogObjectId}`,
      );
      if (!res.ok) throw new Error(`catalog-modifiers ${res.status}`);
      const data = await res.json();
      return {
        catalogObjectId: ci.squareCatalogObjectId,
        name: ci.label,
        includedModifierCount: ci.includedModifierCount ?? 1,
        extraModifierCents: ci.extraModifierCents ?? 0,
        groups: (Array.isArray(data) ? data : []) as ModifierGroup[],
      };
    }),
  );
  // A configured item with NO groups is a broken catalog link, not a food-free
  // item: the package says it includes a pick and there is nothing to pick from.
  // Surface it as a load failure (retry) rather than silently dropping the item
  // — dropping it is how the server backstop would then refuse the booking.
  if (built.some((f) => f.groups.length === 0)) {
    throw new Error("configured food item has no modifier groups");
  }
  return built;
}

const BowlingFoodStepComponent: StepDef<BowlingItem>["Component"] = ({ item, onChange }) => {
  const centerCode = item.qamfCenterId ? QAMF_TO_CENTER_CODE[item.qamfCenterId] : null;
  // Nothing to load against (no experience / centre yet) reads as a failed
  // load: `foodItems` stays undefined so the gate holds. The guest cannot be on
  // this step without an experience anyway.
  const canLoad = !!item.experienceId && !!centerCode;
  const [loading, setLoading] = useState(canLoad && item.foodItems === undefined);
  const [loadFailed, setLoadFailed] = useState(!canLoad);
  const [attempt, setAttempt] = useState(0);
  const t = useT();

  const foodItems = item.foodItems;
  const selections = item.pizzaModifierSelections;
  const laneCount = Math.max(1, item.laneCount);

  useEffect(() => {
    if (!canLoad) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    void (async () => {
      try {
        const loaded = await loadFoodItems(item.experienceId!, centerCode);
        if (cancelled) return;
        onChange({ foodItems: loaded });
      } catch (err) {
        if (cancelled) return;
        console.warn("[BowlingFoodStep] food config load failed:", err);
        // Keep a previously loaded config if we have one; a transient failure
        // on a revisit should not wipe the picks the guest already made.
        setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canLoad, item.experienceId, centerCode, attempt]);

  // `rawItems` is what the reserve rails send to Square and persist to Neon.
  // Rebuild it from the CURRENT picks and lane count rather than only on tap:
  // a guest who goes back and adds or removes a lane after this step would
  // otherwise book with a stale lane list (the server refuses that, but the
  // refusal should never be reachable from an honest client).
  useEffect(() => {
    if (!foodItems || foodItems.length === 0) return;
    const next = buildFoodRawItems({ foodItems, selections, laneCount });
    if (JSON.stringify(next) !== JSON.stringify(item.rawItems)) onChange({ rawItems: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foodItems, selections, laneCount]);

  if (loading && !foodItems) {
    return (
      <div className="flex items-center justify-center py-16">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-white/15"
          style={{ borderTopColor: BLUE }}
        />
      </div>
    );
  }

  // Failed to load, or loaded nothing configurable: BOTH block the step (see
  // foodSelectionIssue). The guest retries; the front desk is the fallback.
  if (!foodItems || foodItems.length === 0) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-8 text-center">
        <p className="text-sm text-white/70">
          {loadFailed ? t("food.err.loadFailed") : t("food.err.unavailable")}
        </p>
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          disabled={loading}
          className="min-h-11 rounded-lg px-5 py-2.5 text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-40"
          style={{ backgroundColor: BLUE, color: "#0a1628" }}
        >
          {t("food.retry")}
        </button>
      </div>
    );
  }

  return (
    <FoodPicker
      foodItems={foodItems}
      selections={selections}
      laneCount={laneCount}
      accent={BLUE}
      onTap={(laneIndex, group, optionId) =>
        onChange({
          pizzaModifierSelections: toggleSelection({
            selections,
            laneIndex,
            groupId: group.id,
            optionId,
            selectionType: group.selectionType,
          }),
        })
      }
    />
  );
};

/**
 * Experience slugs whose packages bundle configurable food. A substring list
 * rather than a DB read because `isVisible` must be synchronous.
 *
 * This list is also the REQUIREMENT: a package named here must load at least
 * one configurable item or the step blocks (foodSelectionIssue). Add a slug
 * here and seed its $0 food items in the same change.
 *
 * Declared ABOVE the StepDef on purpose: a module-scope const referenced from a
 * step callback must initialize before anything closes over it (TDZ lesson).
 */
const CONFIGURABLE_FOOD_SLUG_PARTS = ["pizza-bowl", "nfl-vip"];

const BowlingFoodStep: StepDef<BowlingItem> = {
  id: "bowling-food",
  title: "Food",
  Component: BowlingFoodStepComponent,
  isVisible: (item) => {
    const slug = item.experienceSlug ?? "";
    return CONFIGURABLE_FOOD_SLUG_PARTS.some((part) => slug.includes(part));
  },
  canAdvance: (item) => {
    const issue = foodSelectionIssue({
      foodItems: item.foodItems,
      selections: item.pizzaModifierSelections ?? [],
      laneCount: item.laneCount || 1,
    });
    return issue ? { reason: issue } : true;
  },
};

export default BowlingFoodStep;
