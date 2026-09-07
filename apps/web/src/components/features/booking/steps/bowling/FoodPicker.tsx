"use client";

/**
 * The package-food picker — lane tabs, one section per food item, an even grid
 * of options per group, a running extras total. Pure presentation: it renders
 * `foodItems` + `selections` and reports taps; the caller owns state.
 *
 * Extracted from BowlingFoodStep (2026-09-06) because the same picker now has
 * to appear in FOUR places — the booking step, the confirmation page's editor,
 * the web + kiosk "open lane" gates, and the reservation-admin card — and four
 * copies of a pizza picker is how the old EditPizzaPanel drifted from the
 * booking step (it hardcoded two catalog ids and a drink regex the step had
 * already dropped). One picker, one set of rules (food-config.ts).
 *
 * Copy goes through the kiosk i18n catalog (shared web/kiosk component; `useT`
 * falls back to English where there is no provider — admin, web).
 */

import { useState } from "react";
import { IconCheck } from "@tabler/icons-react";
import { useT } from "~/features/kiosk/i18n/useT";
import {
  extraCentsForLane,
  extraPicksForLane,
  includedPicksOwed,
  isRequired,
  laneFoodComplete,
  remainingPicks,
  type FoodItem,
  type LaneSelections,
  type ModifierGroup,
} from "~/features/booking/service/food-config";

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export interface FoodPickerProps {
  foodItems: readonly FoodItem[];
  selections: readonly LaneSelections[];
  laneCount: number;
  /** A tap on one option. The caller applies toggleSelection and re-renders. */
  onTap: (laneIndex: number, group: ModifierGroup, optionId: string) => void;
  /** Bowling reads BLUE (owner 2026-07-19); the confirmation page uses its coral. */
  accent?: string;
  /** Text colour on an accent-filled control. */
  onAccent?: string;
  /** Hide the title/subtitle when the host supplies its own heading. */
  hideHeading?: boolean;
}

export function FoodPicker({
  foodItems,
  selections,
  laneCount: laneCountIn,
  onTap,
  accent = "#00E2E5",
  onAccent = "#0a1628",
  hideHeading = false,
}: FoodPickerProps) {
  const t = useT();
  const [activeLane, setActiveLane] = useState(0);
  const laneCount = Math.max(1, laneCountIn);
  const lane = Math.min(activeLane, laneCount - 1);
  const laneSel = selections[lane] ?? {};

  const laneDone = Array.from({ length: laneCount }, (_, i) =>
    laneFoodComplete(foodItems, selections[i] ?? {}),
  );
  const totalExtras = Array.from({ length: laneCount }).reduce<number>(
    (sum, _, i) => sum + extraCentsForLane(foodItems, selections[i] ?? {}),
    0,
  );

  function tap(group: ModifierGroup, optionId: string) {
    const chosen = laneSel[group.id] ?? [];
    // Respect Square's max: a full MULTIPLE group ignores new taps rather than
    // silently dropping an earlier choice the guest cannot see them lose.
    if (!chosen.includes(optionId) && group.selectionType === "MULTIPLE") {
      const left = remainingPicks(group, chosen.length);
      if (left !== null && left <= 0) return;
    }
    onTap(lane, group, optionId);
  }

  return (
    <div className="mx-auto max-w-xl space-y-5">
      {!hideHeading && (
        <div className="text-center">
          <h2 className="font-display text-2xl uppercase tracking-widest text-white">
            {t("food.title")}
          </h2>
          <p className="mt-1 text-sm text-white/45">{t("food.subtitle")}</p>
        </div>
      )}

      {/* Lane tabs — one lane on screen, each showing whether it's finished. */}
      {laneCount > 1 && (
        <div
          role="tablist"
          aria-label={t("food.laneOf", { n: lane + 1, total: laneCount })}
          className="flex gap-2 overflow-x-auto pb-1"
        >
          {Array.from({ length: laneCount }).map((_, i) => {
            const on = i === lane;
            return (
              <button
                key={i}
                role="tab"
                type="button"
                aria-selected={on}
                onClick={() => setActiveLane(i)}
                className="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold uppercase tracking-wider transition-all"
                style={{
                  backgroundColor: on ? accent : "rgba(255,255,255,0.05)",
                  color: on ? onAccent : "rgba(255,255,255,0.6)",
                }}
              >
                {t("food.lane", { n: i + 1 })}
                {laneDone[i] && (
                  <IconCheck size={14} aria-hidden style={{ color: on ? onAccent : accent }} />
                )}
              </button>
            );
          })}
        </div>
      )}

      {foodItems.map((food) => {
        const extras = extraPicksForLane(food, laneSel);
        const allowanceCents = extras * food.extraModifierCents;
        // The ITEM-level requirement: the package includes N picks on this
        // item, so N picks are owed — regardless of what Square says about any
        // one of its lists. Shown on the item header while still owed.
        const owed = includedPicksOwed(food, laneSel);
        return (
          <section
            key={food.catalogObjectId}
            className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
          >
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h3 className="text-sm font-bold text-white">{food.name}</h3>
                {owed > 0 && (
                  <span
                    className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                    style={{ backgroundColor: "rgba(251,191,36,0.15)", color: "#fbbf24" }}
                  >
                    {t("food.required")} · {t("food.pickN", { n: owed })}
                  </span>
                )}
                {owed === 0 && food.includedModifierCount > 0 && (
                  <IconCheck size={13} aria-hidden style={{ color: accent }} />
                )}
              </div>
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
                // A list Square leaves un-minimumed on an item that still owes
                // its included pick is not "optional" from the guest's seat —
                // the pick can come from any of the item's lists. Only call a
                // list optional once the item itself is satisfied.
                const showOptional = !required && owed === 0 && food.includedModifierCount > 0;

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
                        <IconCheck size={13} aria-hidden style={{ color: accent }} />
                      )}
                      <span className="text-[10px] text-white/35">
                        {showOptional ? `${t("food.optional")} · ${rule}` : rule}
                      </span>
                    </div>

                    {/* An even GRID, not flex-wrap. Toppings run 4-13 items of
                        wildly different name lengths, and wrapping them ragged
                        makes a list you hunt through rather than scan down.
                        Fixed columns give every option the same target and the
                        same left edge — thumb targets on the kiosk. */}
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
                            onClick={() => tap(group, opt.id)}
                            // min-h-11 ≈ 44px: this renders zoomed on the kiosk
                            // and the old chips were a thumb-width too small.
                            className="flex min-h-11 items-center justify-between gap-1 rounded-lg border px-2.5 py-2 text-left text-xs transition-all disabled:cursor-not-allowed disabled:opacity-25"
                            style={{
                              // Unselected is NEUTRAL; the accent means "picked".
                              borderColor: on ? accent : "rgba(255,255,255,0.10)",
                              backgroundColor: on ? accent : "rgba(255,255,255,0.03)",
                              color: on ? onAccent : "rgba(255,255,255,0.85)",
                              fontWeight: on ? 700 : 500,
                            }}
                          >
                            <span className="min-w-0 truncate">{opt.name}</span>
                            {price > 0 && (
                              <span
                                className="shrink-0 text-[10px] tabular-nums"
                                style={{ color: on ? onAccent : "rgba(255,255,255,0.45)" }}
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
          <span
            className="text-sm font-bold"
            style={{ color: totalExtras > 0 ? "#fbbf24" : accent }}
          >
            {totalExtras > 0 ? `+${money(totalExtras)}` : money(0)}
          </span>
        </div>
      )}

      {laneCount > 1 && lane < laneCount - 1 && (
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
}
