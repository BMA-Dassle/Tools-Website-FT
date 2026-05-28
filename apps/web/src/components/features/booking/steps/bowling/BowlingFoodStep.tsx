"use client";

import { useEffect, useState } from "react";
import type { BowlingItem, StepDef } from "~/features/booking";

const CORAL = "#fd5b56";

const PIZZA_BOWL_PIZZA_CATALOG_ID = "2IKZB4O2HQBXWMTSUQ2SEKJY";
const PIZZA_BOWL_SODA_CATALOG_ID = "SJUBJLB4QGHIHCW5AKTTMLH7";
const PIZZA_BOWL_FREE_TOPPINGS = 1;

interface ModifierGroup {
  id: string;
  name: string;
  selectionType: "SINGLE" | "MULTIPLE";
  options: Array<{ id: string; name: string }>;
}

const BowlingFoodStepComponent: StepDef<BowlingItem>["Component"] = ({ item, onChange }) => {
  const [groups, setGroups] = useState<ModifierGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const selections = item.pizzaModifierSelections;
  const laneCount = item.laneCount;

  useEffect(() => {
    if (!item.experienceSlug?.includes("pizza-bowl")) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/bowling/v2/catalog-modifiers?catalogObjectId=${PIZZA_BOWL_PIZZA_CATALOG_ID}`,
        );
        const data = await res.json();
        if (res.ok && Array.isArray(data)) {
          setGroups(data);
        }
      } catch {
        // Non-fatal — modifiers are a convenience
      } finally {
        setLoading(false);
      }
    })();
  }, [item.experienceSlug]);

  function toggleOption(laneIdx: number, groupId: string, optionId: string, isSingle: boolean) {
    const next = [...selections];
    if (!next[laneIdx]) next[laneIdx] = {};
    const laneSel = { ...next[laneIdx] };
    const current = laneSel[groupId] ?? [];

    if (isSingle) {
      laneSel[groupId] = current.includes(optionId) ? [] : [optionId];
    } else {
      laneSel[groupId] = current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId];
    }
    next[laneIdx] = laneSel;

    const rawItems = next.flatMap((sel, idx) => {
      const prefix = laneCount > 1 ? `Lane ${idx + 1}: ` : "";
      const toppingNames = groups
        .filter((g) => !/soda|drink|pitcher/i.test(g.name))
        .flatMap((g) =>
          (sel[g.id] ?? []).map((id) => g.options.find((o) => o.id === id)?.name ?? id),
        )
        .join(", ");
      const sodaNames = groups
        .filter((g) => /soda|drink|pitcher/i.test(g.name))
        .flatMap((g) =>
          (sel[g.id] ?? []).map((id) => g.options.find((o) => o.id === id)?.name ?? id),
        )
        .join(", ");
      return [
        {
          catalogObjectId: PIZZA_BOWL_PIZZA_CATALOG_ID,
          name: "Pizza Bowl Pizza",
          quantity: 1,
          ...(toppingNames ? { note: `${prefix}${toppingNames}` } : {}),
        },
        {
          catalogObjectId: PIZZA_BOWL_SODA_CATALOG_ID,
          name: "Pizza Bowl Soda Pitcher",
          quantity: 1,
          ...(sodaNames ? { note: `${prefix}${sodaNames}` } : {}),
        },
      ];
    });

    onChange({ pizzaModifierSelections: next, rawItems });
  }

  function countToppings(sel: Record<string, string[]>): number {
    let count = 0;
    for (const group of groups) {
      if (/soda|drink|pitcher/i.test(group.name)) continue;
      count += (sel[group.id] ?? []).length;
    }
    return count;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-white/15"
          style={{ borderTopColor: CORAL }}
        />
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="mx-auto max-w-md py-8 text-center">
        <p className="text-sm text-white/50">Food selections will be taken at the center.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="text-center">
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">
          Customize Your Pizza Bowl
        </h2>
        <p className="mt-1 text-sm text-white/40">
          {PIZZA_BOWL_FREE_TOPPINGS} topping included per lane &middot; $1 each extra
        </p>
      </div>

      {Array.from({ length: laneCount }).map((_, laneIdx) => (
        <div
          key={laneIdx}
          className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-4"
        >
          {laneCount > 1 && (
            <h3 className="text-xs font-bold uppercase tracking-widest text-white/40">
              Lane {laneIdx + 1}
            </h3>
          )}

          {groups.map((group) => {
            const laneSel = selections[laneIdx] ?? {};
            const selected = laneSel[group.id] ?? [];
            const isSoda = /soda|drink|pitcher/i.test(group.name);

            return (
              <div key={group.id}>
                <p className="mb-2 text-xs font-semibold text-white/60">
                  {group.name}
                  {!isSoda && (
                    <span className="ml-1 text-white/30">
                      ({selected.length}/{PIZZA_BOWL_FREE_TOPPINGS} free)
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
                        onClick={() =>
                          toggleOption(laneIdx, group.id, opt.id, group.selectionType === "SINGLE")
                        }
                        className="rounded-lg px-3 py-1.5 text-xs font-medium transition-all"
                        style={{
                          backgroundColor: isSelected ? CORAL : "rgba(253,91,86,0.10)",
                          color: isSelected ? "#0a1628" : CORAL,
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

          {countToppings(selections[laneIdx] ?? {}) > PIZZA_BOWL_FREE_TOPPINGS && (
            <p className="text-xs text-amber-400">
              +$
              {(countToppings(selections[laneIdx] ?? {}) - PIZZA_BOWL_FREE_TOPPINGS).toFixed(
                2,
              )}{" "}
              extra topping
              {countToppings(selections[laneIdx] ?? {}) - PIZZA_BOWL_FREE_TOPPINGS > 1 ? "s" : ""}
            </p>
          )}
        </div>
      ))}
    </div>
  );
};

const BowlingFoodStep: StepDef<BowlingItem> = {
  id: "bowling-food",
  title: "Food",
  Component: BowlingFoodStepComponent,
  isVisible: (item) => (item.experienceSlug ?? "").includes("pizza-bowl"),
  canAdvance: () => true,
};

export default BowlingFoodStep;
