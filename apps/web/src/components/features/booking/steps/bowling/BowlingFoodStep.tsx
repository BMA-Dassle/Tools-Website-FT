"use client";

/**
 * Package food configuration — "Customize your package".
 *
 * CONFIG-DRIVEN as of 2026-08-25. This step used to hardcode the two Pizza Bowl
 * Square catalog ids, guess which group was the drink with a
 * `/soda|drink|pitcher/i` regex over its NAME, and carry "1 free topping, $1
 * extra" as module constants. Adding a second package (NFL game day: pizza +
 * wings with a heat and a dressing choice + pitcher) would have meant a third
 * hardcode and a second regex.
 *
 * Now: the $0 items on the booked experience ARE the configurable food, each
 * with its own Square modifier groups and its own
 * `included_modifier_count` / `extra_modifier_cents`. A new package is a seed
 * row, not a component edit. All the logic lives in
 * ~/features/booking/service/food-config so it can be unit-tested; this file is
 * fetching plus markup.
 *
 * Grouping matters: choices are rendered and noted PER FOOD ITEM, so a wings
 * line reads "Mild, Ranch" rather than every choice being smeared across every
 * line the way a single flat group list would.
 */

import { useEffect, useState } from "react";
import type { BowlingItem, StepDef } from "~/features/booking";
import type { BowlingExperienceWithDetails } from "@/lib/bowling-db";
import { QAMF_TO_CENTER_CODE } from "~/features/booking/service/bowling-hours";
import {
  allGroups,
  buildFoodRawItems,
  configurableFoodItems,
  extraPicksForLane,
  foodSelectionIssue,
  toggleSelection,
  type FoodItem,
  type ModifierGroup,
} from "~/features/booking/service/food-config";

// Bowling wizard accent — owner 2026-07-19: bowling reads BLUE ("red just
// seems negative"); FastTrax red stays on racing only. VIP keeps gold.
const BLUE = "#00E2E5";

const BowlingFoodStepComponent: StepDef<BowlingItem>["Component"] = ({ item, onChange }) => {
  const [foodItems, setFoodItems] = useState<FoodItem[]>([]);
  const [loading, setLoading] = useState(true);
  const selections = item.pizzaModifierSelections;
  const laneCount = Math.max(1, item.laneCount);
  const centerCode = item.qamfCenterId ? QAMF_TO_CENTER_CODE[item.qamfCenterId] : null;

  useEffect(() => {
    if (!item.experienceId || !centerCode) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        // 1. The booked experience, for its item list.
        const expRes = await fetch(`/api/bowling/v2/experiences?centerCode=${centerCode}`);
        const exps: BowlingExperienceWithDetails[] = expRes.ok ? await expRes.json() : [];
        const exp = Array.isArray(exps) ? exps.find((e) => e.id === item.experienceId) : undefined;
        const configurable = configurableFoodItems(exp?.items);
        if (configurable.length === 0) {
          if (!cancelled) setLoading(false);
          return;
        }

        // 2. Each $0 item's modifier groups. Fetched per item, not merged into
        //    one list, so a choice can be attributed back to the item it
        //    belongs to when the note is written.
        const built = await Promise.all(
          configurable.map(async (ci): Promise<FoodItem> => {
            const res = await fetch(
              `/api/bowling/v2/catalog-modifiers?catalogObjectId=${ci.squareCatalogObjectId}`,
            );
            const data = res.ok ? await res.json() : [];
            return {
              catalogObjectId: ci.squareCatalogObjectId,
              name: ci.label,
              includedModifierCount: ci.includedModifierCount ?? 1,
              extraModifierCents: ci.extraModifierCents ?? 0,
              groups: (Array.isArray(data) ? data : []) as ModifierGroup[],
            };
          }),
        );
        const withGroups = built.filter((f) => f.groups.length > 0);
        if (cancelled) return;
        setFoodItems(withGroups);
        if (withGroups.length > 0) {
          // Every loaded group needs a pick before the guest may continue.
          // Recorded on the item because canAdvance is module-scope and cannot
          // reach component state. Legacy field name — see food-config.ts.
          onChange({ pizzaSodaGroupIds: allGroups(withGroups).map((g) => g.id) });
        }
      } catch {
        // Non-fatal — modifiers are a convenience, and canAdvance fails open.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item.experienceId, centerCode]);

  function tap(laneIdx: number, group: ModifierGroup, optionId: string) {
    const next = toggleSelection({
      selections,
      laneIndex: laneIdx,
      groupId: group.id,
      optionId,
      selectionType: group.selectionType,
    });
    onChange({
      pizzaModifierSelections: next,
      rawItems: buildFoodRawItems({ foodItems, selections: next, laneCount }),
    });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-white/15"
          style={{ borderTopColor: BLUE }}
        />
      </div>
    );
  }

  if (foodItems.length === 0) {
    return (
      <div className="mx-auto max-w-md py-8 text-center">
        <p className="text-sm text-white/50">Food selections will be taken at the center.</p>
      </div>
    );
  }

  const chargeable = foodItems.filter((f) => f.extraModifierCents > 0);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="text-center">
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">
          Customize Your Package
        </h2>
        {chargeable.length > 0 && (
          <p className="mt-1 text-sm text-white/40">
            {chargeable[0].includedModifierCount} included per lane &middot; $
            {(chargeable[0].extraModifierCents / 100).toFixed(2)} each extra
          </p>
        )}
      </div>

      {Array.from({ length: laneCount }).map((_, laneIdx) => {
        const laneSel = selections[laneIdx] ?? {};
        return (
          <div
            key={laneIdx}
            className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-4"
          >
            {laneCount > 1 && (
              <h3 className="text-xs font-bold uppercase tracking-widest text-white/40">
                Lane {laneIdx + 1}
              </h3>
            )}

            {foodItems.map((food) => {
              const extras = extraPicksForLane(food, laneSel);
              const extraCents = extras * food.extraModifierCents;
              return (
                <div key={food.catalogObjectId} className="space-y-3">
                  {foodItems.length > 1 && (
                    <p className="text-[11px] font-bold uppercase tracking-wider text-white/50">
                      {food.name}
                    </p>
                  )}

                  {food.groups.map((group) => {
                    const selected = laneSel[group.id] ?? [];
                    const charges = food.extraModifierCents > 0;
                    return (
                      <div key={group.id}>
                        <p className="mb-2 text-xs font-semibold text-white/60">
                          {group.name}
                          {charges ? (
                            <span className="ml-1 text-white/30">
                              ({selected.length}/{food.includedModifierCount} free)
                            </span>
                          ) : (
                            <span
                              className="ml-1"
                              style={{
                                color: selected.length > 0 ? "rgba(255,255,255,0.3)" : BLUE,
                              }}
                            >
                              (required)
                            </span>
                          )}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {group.options.map((opt) => {
                            const isSelected = selected.includes(opt.id);
                            return (
                              <button
                                key={opt.id}
                                type="button"
                                onClick={() => tap(laneIdx, group, opt.id)}
                                className="rounded-lg px-3 py-1.5 text-xs font-medium transition-all"
                                style={{
                                  backgroundColor: isSelected ? BLUE : "rgba(0,226,229,0.10)",
                                  color: isSelected ? "#0a1628" : BLUE,
                                  fontWeight: isSelected ? 700 : 500,
                                }}
                              >
                                {opt.name}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}

                  {extraCents > 0 && (
                    <p className="text-xs text-amber-400">
                      +${(extraCents / 100).toFixed(2)} extra{extras > 1 ? "s" : ""}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};

/**
 * Experience slugs whose packages bundle configurable food. A substring list
 * rather than a DB read because `isVisible` must be synchronous.
 *
 * Declared ABOVE the StepDef on purpose: a module-scope const referenced from a
 * step callback must initialize before anything can close over it (TDZ lesson —
 * the same trap `isUntouchedBowlingDraft` documents in KioskFlow).
 *
 * Adding a package here also means seeding its $0 items with modifier lists. If
 * the slug matches but nothing configurable comes back, the step renders "Food
 * selections will be taken at the center." — the safe failure.
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
      requiredGroupIds: item.pizzaSodaGroupIds ?? [],
      selections: item.pizzaModifierSelections ?? [],
      laneCount: item.laneCount || 1,
    });
    return issue ? { reason: issue } : true;
  },
};

export default BowlingFoodStep;
