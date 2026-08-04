"use client";

/**
 * KIOSK race step — page 1 of 2: HOW they're paying, before WHICH race.
 *
 * The product step used to carry three decisions at once (bundles, prepaid
 * credit packs, and the tier list) on one portrait screen; with the pack catalog
 * at six SKUs the tier cards sat well below the fold. This step takes the money
 * decision — single races vs a credit pack vs a premium bundle — and the product
 * step keeps only "which race".
 *
 * Per CATEGORY, exactly like the product and heat steps it precedes: adult and
 * junior are separate BMI SKUs at separate prices, and a package is a
 * per-category selection (`packageIdAdult` / `packageIdJunior`). A mixed party
 * therefore answers it once per category — the same shape the rest of the race
 * flow already has.
 *
 * Choosing a BUNDLE skips the product step entirely (the bundle owns the race,
 * so the next stop is its heat picker) — `RaceProductStep.isVisible` reads the
 * same `payModeStepVisible` seam, so page 2 can never disagree about whether
 * page 1 exists. Choosing "just today's races" CLEARS any bundle, so the guest
 * can always get back to the tier list.
 *
 * KIOSK ONLY, and only when there is something to choose: with no packs offered
 * and no eligible bundle this step would be a screen with one button, so it
 * hides and the guest lands straight on the race list. Web keeps its single
 * screen (its cart/back-nav is free, so the split buys nothing there).
 */
import { useEffect, useState } from "react";
import type { RaceItem, StepDef } from "~/features/booking";
import { packageIdForCategory } from "~/features/booking";
import { releaseHeatBmiLines } from "~/features/booking/service/checkout";
import { clearPackageForCategory } from "~/features/booking/service/package-selection";
import { eligiblePackages } from "~/features/booking/service/packages";
import { scheduleForDate } from "~/features/booking/service/race-pricing";
import {
  combineTrackVariants,
  filterProducts,
  productsForSchedule,
  type RacerType,
} from "~/features/booking/service/race-products";
import {
  coveredMembersPreview,
  kioskPackSkus,
  kioskRacePacksEnabled,
} from "~/features/booking/service/race-pack-kiosk";
import { useT } from "~/features/kiosk/i18n";
import { PackageCard } from "./PackageCard";
import { racePackTeaserVisible } from "./RacePackTeaser";
import { RacePackPicker, SINGLE_RACE_BASELINE } from "./RacePackPicker";

type Category = "adult" | "junior";

function racersOfCategory<T extends { category?: Category }>(party: T[], category: Category): T[] {
  return party.filter((m) => (m.category ?? "adult") === category);
}

/** Bundles this category can buy today (empty for a returning-racer category —
 *  Rookie Pack is new-racers-only, and the Ultimate Qualifier has its own
 *  schedule rules). */
function bundlesFor(
  item: RaceItem,
  session: { party: { category?: Category; isNewRacer: boolean }[] },
  category: Category,
) {
  if (!item.date) return [];
  const racers = racersOfCategory(session.party, category);
  if (racers.length === 0) return [];
  const racerType: RacerType = racers.every((m) => m.isNewRacer) ? "new" : "existing";
  return eligiblePackages({ racerType, schedule: scheduleForDate(item.date), category });
}

/**
 * Does page 1 exist for this category? Exported so the product step can drop the
 * bundle + pack blocks it moved here (and hide itself once a bundle is chosen)
 * without duplicating the rule — the two must never disagree.
 */
export function payModeStepVisible(
  item: RaceItem,
  session: Parameters<typeof racePackTeaserVisible>[0],
  category: Category,
): boolean {
  if (!session.context?.kiosk) return false;
  if (!item.date) return false;
  if (racersOfCategory(session.party, category).length === 0) return false;
  const hasPacks = racePackTeaserVisible(session) && kioskPackSkus().length > 0;
  return hasPacks || bundlesFor(item, session, category).length > 0;
}

function makePayModeComponent(category: Category): StepDef<RaceItem>["Component"] {
  const PayMode: StepDef<RaceItem>["Component"] = ({ item, session, onChange, requestAdvance }) => {
    const t = useT();
    const [packOpen, setPackOpen] = useState(false);
    // Advancing is DEFERRED until the pick is committed to item state, the same
    // reason the product step defers its package auto-advance: the host's
    // handleNext re-reads the item to decide which step comes next, and page 2's
    // visibility depends on the very field we just wrote. Advancing in the same
    // tick would route off STALE state — a bundle pick would land on page 2
    // (which then vanishes), and "just today's races" would skip past it.
    const [advanceWhen, setAdvanceWhen] = useState<null | "bundle" | "singles">(null);

    const racers = racersOfCategory(session.party, category);
    const bundles = bundlesFor(item, session, category);
    const selectedBundleId = packageIdForCategory(item, category);
    const packsOn = racePackTeaserVisible(session) && kioskRacePacksEnabled();
    const skus = packsOn ? kioskPackSkus() : [];
    const eligible = session.party.filter((m) => !!m.bmiPersonId);
    const picks = item.creditPacks ?? [];

    // Cheapest single race for this category — the same registry the product step
    // prices its tier cards from, so the two screens can't quote different money.
    const cheapestSingle = (() => {
      if (!item.date) return null;
      const racerType: RacerType = racers.every((m) => m.isNewRacer) ? "new" : "existing";
      const singles = combineTrackVariants(
        filterProducts(productsForSchedule(scheduleForDate(item.date), racerType), {
          racerType,
          adultCount: category === "adult" ? racers.length : 0,
          juniorCount: category === "junior" ? racers.length : 0,
          memberships: racers.flatMap((m) => m.memberships ?? []),
        }).filter((p) => p.category === category),
      ).filter((p) => !p.packType || p.packType === "none");
      return singles.length > 0 ? Math.min(...singles.map((p) => p.price)) : null;
    })();

    const sizes = [...new Set(skus.map((p) => p.raceCount))].join(" · ");
    const cheapestPack = skus[0];
    const maxSave =
      skus.length > 0
        ? Math.max(...skus.map((p) => p.raceCount * SINGLE_RACE_BASELINE - p.price))
        : 0;

    // Racers on this side who already hold banked credits — the "just today's
    // races" card would otherwise read as though they're about to pay again.
    const covered = coveredMembersPreview(item, session.party, item.date);
    const creditNames = racers
      .filter((m) => covered.get((m as { id: string }).id)?.source === "account-credits")
      .map((m) => (m as { firstName: string }).firstName);

    useEffect(() => {
      if (!advanceWhen) return;
      const committed = advanceWhen === "bundle" ? !!selectedBundleId : !selectedBundleId;
      if (!committed) return;
      // Short beat so the selection ring paints before the screen changes.
      const timer = setTimeout(() => {
        setAdvanceWhen(null);
        requestAdvance?.();
      }, 250);
      return () => clearTimeout(timer);
    }, [advanceWhen, selectedBundleId, requestAdvance]);

    const dropBundle = () => {
      const { patch, removed } = clearPackageForCategory(item, category);
      onChange(patch);
      if (removed.some((h) => h.bmiLineId)) void releaseHeatBmiLines(session, removed);
      return removed;
    };

    // Single races: clear any bundle first (its heats are released), then straight
    // to the tier list. Without the clear, the product step would still be hidden
    // and the guest would bounce back here.
    const chooseSingles = () => {
      if (!selectedBundleId) {
        requestAdvance?.();
        return;
      }
      dropBundle();
      setAdvanceWhen("singles");
    };

    return (
      <div className="mx-auto w-full max-w-[760px] space-y-5">
        <div className="space-y-2 text-center">
          <h3 className="font-display text-2xl tracking-widest text-white uppercase">
            {t("payMode.heading")}
          </h3>
          <p className="mx-auto max-w-md text-sm text-white/40">{t("payMode.sub")}</p>
        </div>

        {creditNames.length > 0 && (
          <p className="rounded-xl border border-[#00E2E5]/30 bg-[#00E2E5]/5 p-3 text-center text-sm text-[#00E2E5]">
            {t("payMode.credits", { names: creditNames.join(" & "), count: creditNames.length })}
          </p>
        )}

        {/* 1 — pay per race. Also the "no thanks" for everything below it. */}
        <button
          type="button"
          onClick={chooseSingles}
          className="w-full rounded-xl border-2 border-[#00E2E5]/40 bg-[#00E2E5]/[0.04] p-4 text-left transition-colors hover:border-[#00E2E5]"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-base font-bold text-white">{t("payMode.single.title")}</span>
            {cheapestSingle != null && (
              <span className="text-sm font-bold text-[#00E2E5] tabular-nums">
                {t("payMode.single.from", { price: `$${cheapestSingle.toFixed(2)}` })}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-white/55">{t("payMode.single.sub")}</p>
        </button>

        {/* 2 — prepaid credit packs (3/5/10). Opens in place: assigning a pack to
            two racers is two taps inside one card, not two screens. */}
        {packsOn && skus.length > 0 && (
          <div className="rounded-xl border border-amber-500/25 bg-linear-to-br from-amber-500/10 to-amber-500/5">
            <button
              type="button"
              onClick={() => setPackOpen((o) => !o)}
              aria-expanded={packOpen}
              className="block w-full p-4 text-left"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-base font-bold text-amber-400">
                  {t("payMode.pack.title", { sizes })}
                </span>
                <span className="text-sm font-bold text-amber-400 tabular-nums">
                  {t("racePack.teaser.from", { price: `$${cheapestPack.price.toFixed(2)}` })}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-white/55">{t("payMode.pack.sub")}</p>
              <span className="mt-1 inline-block text-xs font-bold text-amber-400">
                {t("racePack.teaser.saveUpTo", { amount: `$${maxSave.toFixed(2)}` })}
              </span>
            </button>
            {(packOpen || picks.length > 0) && (
              <div className="px-4 pb-4">
                <RacePackPicker
                  skus={skus}
                  eligible={eligible}
                  picks={picks}
                  onChange={(next) => onChange({ creditPacks: next })}
                />
                {picks.length > 0 && (
                  <p className="mt-3 text-xs font-semibold text-emerald-400">
                    {t("payMode.pack.added", { count: picks.length })}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* 3 — premium bundles. Same cards as before, and picking one goes
            straight to its heat picker (the bundle IS the race). */}
        {bundles.length > 0 && (
          <div className="space-y-3">
            <p className="text-[10px] font-bold tracking-widest text-white/35 uppercase">
              {t("payMode.bundles")}
            </p>
            {bundles.map((pkg) => (
              <div key={pkg.id} className="space-y-2">
                <PackageCard
                  pkg={pkg}
                  racerCount={racers.length}
                  date={item.date}
                  isSelected={selectedBundleId === pkg.id}
                  compact
                  detailsOpen={false}
                  onToggleDetails={undefined}
                  onSelect={() => {
                    if (pkg.id === selectedBundleId) {
                      requestAdvance?.();
                      return;
                    }
                    const { patch, removed } = clearPackageForCategory(item, category);
                    onChange(
                      category === "adult"
                        ? {
                            ...patch,
                            packageIdAdult: pkg.id,
                            productIdAdult: null,
                            productTrackAdult: null,
                          }
                        : {
                            ...patch,
                            packageIdJunior: pkg.id,
                            productIdJunior: null,
                            productTrackJunior: null,
                          },
                    );
                    if (removed.some((h) => h.bmiLineId))
                      void releaseHeatBmiLines(session, removed);
                    setAdvanceWhen("bundle");
                  }}
                />
                {selectedBundleId === pkg.id && (
                  <button
                    type="button"
                    onClick={dropBundle}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/15 px-3 py-2.5 text-xs font-semibold text-white/60 transition-colors hover:border-red-400/40 hover:text-red-300"
                  >
                    <span aria-hidden>✕</span>
                    {t("racePackage.remove", { name: pkg.name })}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <p className="text-center text-xs text-white/40">{t("payMode.footnote")}</p>
      </div>
    );
  };
  return PayMode;
}

export const RacePayModeStepAdult: StepDef<RaceItem> = {
  id: "race-pay-mode-adult",
  title: "Adult Race",
  Component: makePayModeComponent("adult"),
  isVisible: (item, session) => payModeStepVisible(item, session, "adult"),
  // Continue always works: no choice here means single races, which is exactly
  // what page 2 opens on. The step sells; it never blocks.
  canAdvance: () => true,
};

export const RacePayModeStepJunior: StepDef<RaceItem> = {
  id: "race-pay-mode-junior",
  title: "Junior Race",
  Component: makePayModeComponent("junior"),
  isVisible: (item, session) => payModeStepVisible(item, session, "junior"),
  canAdvance: () => true,
};
