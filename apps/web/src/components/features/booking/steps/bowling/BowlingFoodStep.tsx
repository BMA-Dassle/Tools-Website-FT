"use client";

/**
 * Package food configuration — "Customise your package".
 *
 * CONFIG-DRIVEN (2026-08-25) and REDESIGNED (2026-09-01). It used to hardcode
 * two Square catalog ids, guess the drink group with a `/soda|drink|pitcher/i`
 * regex over its NAME, and carry "1 free topping, $1 extra" as module consts.
 * Now the $0 items on the booked experience ARE the configurable food, each with
 * its own modifier groups and allowance, so a new package is a seed row.
 *
 * WHAT THE REDESIGN FIXES (owner, 2026-09-01: "the current pizza bowl one
 * sucks"). The old screen rendered every lane stacked down one page as
 * identical unlabelled chip rows, with no way to tell a required choice from an
 * optional one, no prices on the options that cost money, and no sense of
 * whether you were finished. On a four-lane party that is twenty-odd chip rows
 * with nothing to hold on to.
 *
 *   - LANE TABS instead of a stack. One lane on screen at a time, each tab
 *     showing whether it is done. A four-lane party stops being a scroll.
 *   - REQUIRED vs OPTIONAL is stated, per group, with the pick rule ("Pick 1",
 *     "Pick up to 2"). Optional groups can now exist at all — the API carries
 *     Square's per-item min/max as of today, which is what lets the wings offer
 *     drums-or-flats and extra sauce without trapping anyone.
 *   - PRICES ON THE OPTION. "All Drums +$2.00" reads on the button, not as a
 *     surprise at checkout, and a running extras total sits at the bottom.
 *   - Touch targets sized for the kiosk, which renders this zoomed.
 *
 * All the logic lives in ~/features/booking/service/food-config so it stays
 * unit-testable; this file is fetching plus markup.
 */

import { useEffect, useMemo, useState } from "react";
import type { BowlingItem, StepDef } from "~/features/booking";
import type { BowlingExperienceWithDetails } from "@/lib/bowling-db";
import { QAMF_TO_CENTER_CODE } from "~/features/booking/service/bowling-hours";
import { useT } from "~/features/kiosk/i18n/useT";
import {
  buildFoodRawItems,
  configurableFoodItems,
  extraCentsForLane,
  extraPicksForLane,
  foodSelectionIssue,
  isRequired,
  remainingPicks,
  toggleSelection,
  type FoodItem,
  type LaneSelections,
  type ModifierGroup,
} from "~/features/booking/service/food-config";
import { IconCheck } from "@tabler/icons-react";

// Bowling wizard accent — owner 2026-07-19: bowling reads BLUE.
const BLUE = "#00E2E5";
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

/** Groups on this lane that still need an answer. */
function unansweredGroups(foodItems: readonly FoodItem[], sel: LaneSelections): ModifierGroup[] {
  return foodItems
    .flatMap((f) => f.groups)
    .filter((g) => isRequired(g) && (sel[g.id]?.length ?? 0) < (g.minSelected ?? 1));
}

const BowlingFoodStepComponent: StepDef<BowlingItem>["Component"] = ({ item, onChange }) => {
  const [foodItems, setFoodItems] = useState<FoodItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeLane, setActiveLane] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

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
        const expRes = await fetch(`/api/bowling/v2/experiences?centerCode=${centerCode}`);
        const exps: BowlingExperienceWithDetails[] = expRes.ok ? await expRes.json() : [];
        const exp = Array.isArray(exps) ? exps.find((e) => e.id === item.experienceId) : undefined;
        const configurable = configurableFoodItems(exp?.items);
        if (configurable.length === 0) {
          if (!cancelled) setLoading(false);
          return;
        }
        // Per item, not merged — attributing a choice back to the item it
        // belongs to is what makes a wings line read "Mild, Ranch".
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
          // ONLY the required groups. An optional one in this list would trap
          // the guest on the step with no way to satisfy it.
          onChange({
            pizzaSodaGroupIds: withGroups
              .flatMap((f) => f.groups)
              .filter(isRequired)
              .map((g) => g.id),
          });
        }
      } catch {
        if (!cancelled) setError(t("food.err.loadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item.experienceId, centerCode]);

  const laneDone = useMemo(
    () =>
      Array.from({ length: laneCount }, (_, i) =>
        foodItems.length === 0
          ? true
          : unansweredGroups(foodItems, selections[i] ?? {}).length === 0,
      ),
    [foodItems, selections, laneCount],
  );

  const totalExtras = useMemo(
    () =>
      Array.from({ length: laneCount }).reduce<number>(
        (sum, _, i) => sum + extraCentsForLane(foodItems, selections[i] ?? {}),
        0,
      ),
    [foodItems, selections, laneCount],
  );

  function tap(laneIdx: number, group: ModifierGroup, optionId: string) {
    const chosen = selections[laneIdx]?.[group.id] ?? [];
    const isSelected = chosen.includes(optionId);
    // Respect Square's max: a full MULTIPLE group ignores new taps rather than
    // silently dropping an earlier choice the guest cannot see them lose.
    if (!isSelected && group.selectionType === "MULTIPLE") {
      const left = remainingPicks(group, chosen.length);
      if (left !== null && left <= 0) return;
    }
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
        <p className="text-sm text-white/50">{error ?? t("food.atCenter")}</p>
      </div>
    );
  }

  const laneSel = selections[activeLane] ?? {};

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <div className="text-center">
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">
          {t("food.title")}
        </h2>
        <p className="mt-1 text-sm text-white/45">{t("food.subtitle")}</p>
      </div>

      {/* Lane tabs — one lane on screen, each showing whether it's finished. */}
      {laneCount > 1 && (
        <div
          role="tablist"
          aria-label={t("food.laneOf", { n: activeLane + 1, total: laneCount })}
          className="flex gap-2 overflow-x-auto pb-1"
        >
          {Array.from({ length: laneCount }).map((_, i) => {
            const on = i === activeLane;
            return (
              <button
                key={i}
                role="tab"
                type="button"
                aria-selected={on}
                onClick={() => setActiveLane(i)}
                className="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold uppercase tracking-wider transition-all"
                style={{
                  backgroundColor: on ? BLUE : "rgba(255,255,255,0.05)",
                  color: on ? "#0a1628" : "rgba(255,255,255,0.6)",
                }}
              >
                {t("food.lane", { n: i + 1 })}
                {laneDone[i] && (
                  <IconCheck size={14} aria-hidden style={{ color: on ? "#0a1628" : BLUE }} />
                )}
              </button>
            );
          })}
        </div>
      )}

      {foodItems.map((food) => {
        const extras = extraPicksForLane(food, laneSel);
        const allowanceCents = extras * food.extraModifierCents;
        return (
          <section
            key={food.catalogObjectId}
            className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
          >
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-bold text-white">{food.name}</h3>
              {food.extraModifierCents > 0 && (
                <span className="shrink-0 text-[11px] text-white/40">
                  {t("food.included", { n: food.includedModifierCount })} ·{" "}
                  {money(food.extraModifierCents)} {t("food.extrasTotal").toLowerCase()}
                </span>
              )}
            </div>

            <div className="space-y-4">
              {food.groups.map((group) => {
                const chosen = laneSel[group.id] ?? [];
                const required = isRequired(group);
                const left = remainingPicks(group, chosen.length);
                const full = left !== null && left <= 0;
                const satisfied = chosen.length >= (group.minSelected ?? 1);
                const rule =
                  group.selectionType === "SINGLE" || group.maxSelected === 1
                    ? t("food.pickOne")
                    : group.maxSelected
                      ? t("food.pickUpTo", { n: group.maxSelected })
                      : t("food.pickAny");

                return (
                  <div key={group.id}>
                    {/* One quiet line, not three competing badges. A REQUIRED
                        pill only earns its colour while it is UNANSWERED: once
                        the guest has picked, shouting "required" at them is
                        noise, and a screen of amber pills makes the one thing
                        still owed impossible to spot. */}
                    <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <p className="text-xs font-semibold text-white/80">{group.name}</p>
                      {required && !satisfied && (
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                          style={{ backgroundColor: "rgba(251,191,36,0.15)", color: "#fbbf24" }}
                        >
                          {t("food.required")}
                        </span>
                      )}
                      {required && satisfied && (
                        <IconCheck size={13} aria-hidden style={{ color: BLUE }} />
                      )}
                      <span className="text-[10px] text-white/35">
                        {required ? rule : `${t("food.optional")} \u00b7 ${rule}`}
                      </span>
                    </div>

                    {/* An even GRID, not flex-wrap. Toppings run 4-13 items of
                        wildly different name lengths, and wrapping them ragged
                        (a 3-wide row, then 5, then a lone orphan) makes a list
                        you hunt through rather than scan down. Fixed columns
                        give every option the same target and the same left
                        edge, which matters twice over on the kiosk where these
                        are thumb targets. */}
                    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                      {group.options.map((opt) => {
                        const on = chosen.includes(opt.id);
                        const price = opt.priceCents ?? 0;
                        const blocked = !on && full;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            aria-pressed={on}
                            disabled={blocked}
                            onClick={() => tap(activeLane, group, opt.id)}
                            // min-h-11 ≈ 44px: this renders zoomed on the kiosk
                            // and the old chips were a thumb-width too small.
                            className="flex min-h-11 items-center justify-between gap-1 rounded-lg border px-2.5 py-2 text-left text-xs transition-all disabled:cursor-not-allowed disabled:opacity-25"
                            style={{
                              // Unselected is NEUTRAL. Rendering every option in
                              // full cyan made a screen where nothing stood out
                              // and a chosen topping was hard to find; the accent
                              // now means "picked".
                              borderColor: on ? BLUE : "rgba(255,255,255,0.10)",
                              backgroundColor: on ? BLUE : "rgba(255,255,255,0.03)",
                              color: on ? "#0a1628" : "rgba(255,255,255,0.85)",
                              fontWeight: on ? 700 : 500,
                            }}
                          >
                            <span className="min-w-0 truncate">{opt.name}</span>
                            {price > 0 && (
                              <span
                                className="shrink-0 text-[10px] tabular-nums"
                                style={{ color: on ? "#0a1628" : "rgba(255,255,255,0.45)" }}
                              >
                                +{money(price)}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {allowanceCents > 0 && (
              <p className="mt-3 text-xs text-amber-400">
                +{money(allowanceCents)} · {extras} {t("food.extrasTotal").toLowerCase()}
              </p>
            )}
          </section>
        );
      })}

      {(totalExtras > 0 || laneCount > 1) && (
        <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
          <span className="text-xs uppercase tracking-wider text-white/50">
            {laneCount > 1 ? t("food.extrasTotal") : t("food.extrasOnLane")}
          </span>
          <span className="text-sm font-bold" style={{ color: totalExtras > 0 ? "#fbbf24" : BLUE }}>
            {totalExtras > 0 ? `+${money(totalExtras)}` : money(0)}
          </span>
        </div>
      )}

      {laneCount > 1 && activeLane < laneCount - 1 && (
        <button
          type="button"
          onClick={() => setActiveLane((n) => n + 1)}
          className="w-full rounded-lg border border-white/10 py-2.5 text-xs font-bold uppercase tracking-wider text-white/60 transition-colors hover:text-white"
        >
          {t("food.nextLane")}
        </button>
      )}
    </div>
  );
};

/**
 * Experience slugs whose packages bundle configurable food. A substring list
 * rather than a DB read because `isVisible` must be synchronous.
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
      requiredGroupIds: item.pizzaSodaGroupIds ?? [],
      selections: item.pizzaModifierSelections ?? [],
      laneCount: item.laneCount || 1,
    });
    return issue ? { reason: issue } : true;
  },
};

export default BowlingFoodStep;
