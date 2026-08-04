"use client";

/**
 * KIOSK race step — page 1 of 2: WHAT they're buying, before WHICH heat.
 *
 * Owner-approved layout (2026-08-03/04, "option 1" after five passes):
 *   ─ one line of qualification context ("everyone starts on a Starter race")
 *   ─ the HOUSE RECOMMENDATION as a hero card (registry `recommended` flag —
 *     the Ultimate Qualifier today), with its race count huge
 *   ─ every other bundle as a thin row carrying a +$delta against the cheapest
 *     way to race, because a first-timer's real decision is the difference,
 *     not the total
 *   ─ the plain single race as the last row
 *   ─ race packs collapsed to ONE line until tapped
 *
 * Type is at the kiosk's own scale (body ~21px, hero 34px, price 40px — see
 * kiosk.css), not the web scale the shared booking components use: this screen
 * is read standing up, next to 112px buttons.
 *
 * Per CATEGORY, like the product and heat steps it precedes: a bundle is a
 * per-category purchase (`packageIdAdult` / `packageIdJunior`) and adult/junior
 * are separate SKUs at separate prices. Picking a bundle SKIPS page 2 (the
 * bundle owns the race) and lands on its heat picker; picking the single race —
 * or removing the bundle — brings page 2 back. `RaceProductStep.isVisible` reads
 * the same `payModeStepVisible` seam, so the two can never disagree.
 *
 * KIOSK ONLY, and only when there is something to choose.
 */
import { useState } from "react";
import type { RaceItem, StepDef } from "~/features/booking";
import { packageIdForCategory } from "~/features/booking";
import { releaseHeatBmiLines } from "~/features/booking/service/checkout";
import { clearPackageForCategory } from "~/features/booking/service/package-selection";
import {
  eligiblePackages,
  getPackage,
  packagePerRacerPrice,
  LICENSE_PRICE,
  type PackageDefinition,
} from "~/features/booking/service/packages";
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
import { useT, type Translate } from "~/features/kiosk/i18n";
import { racePackTeaserVisible } from "./RacePackTeaser";
import { RacePackPicker } from "./RacePackPicker";

type Category = "adult" | "junior";

function racersOfCategory<T extends { category?: Category }>(party: T[], category: Category): T[] {
  return party.filter((m) => (m.category ?? "adult") === category);
}

function racerTypeFor(
  party: { category?: Category; isNewRacer: boolean }[],
  category: Category,
): RacerType {
  const racers = racersOfCategory(party, category);
  return racers.length > 0 && racers.every((m) => m.isNewRacer) ? "new" : "existing";
}

/** Bundles this category can buy today, house recommendation first. */
function bundlesFor(
  item: RaceItem,
  session: { party: { category?: Category; isNewRacer: boolean }[] },
  category: Category,
): PackageDefinition[] {
  if (!item.date) return [];
  if (racersOfCategory(session.party, category).length === 0) return [];
  const list = eligiblePackages({
    racerType: racerTypeFor(session.party, category),
    schedule: scheduleForDate(item.date),
    category,
  });
  return [...list].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended));
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

/** "incl. license · video · appetizer" — built from the bundle's own flags. */
function inclusions(t: Translate, pkg: PackageDefinition): string {
  const parts = [
    ...(pkg.includesLicense ? [t("payMode.incl.license")] : []),
    ...(pkg.includesPov ? [t("payMode.incl.video")] : []),
    ...(pkg.appetizerCode ? [t("payMode.incl.appetizer")] : []),
  ];
  return parts.length > 0 ? t("payMode.incl.prefix", { list: parts.join(" · ") }) : "";
}

/** The one-sentence pitch. Copy lives in the catalog per family so a new bundle
 *  falls back to its own `shortDescription` instead of rendering nothing. */
function bundleSay(t: Translate, pkg: PackageDefinition): string {
  if (pkg.id.startsWith("ultimate-qualifier")) return t("payMode.say.qualifier");
  if (pkg.id.startsWith("rookie-pack")) return t("payMode.say.rookie");
  return pkg.shortDescription;
}

function makePayModeComponent(category: Category): StepDef<RaceItem>["Component"] {
  const PayMode: StepDef<RaceItem>["Component"] = ({ item, session, onChange }) => {
    const t = useT();
    const [packOpen, setPackOpen] = useState(false);
    // Choosing the plain single race writes nothing to the item (there is nothing
    // to write — the tier comes next), so its highlight is LOCAL. Without it the
    // row would have to derive "selected" from "no bundle selected", which paints
    // a choice the guest never made (owner 2026-08-04: "don't auto select
    // anything"). Nothing on this screen advances on tap either — the footer
    // Continue is the only way forward.
    const [singleChosen, setSingleChosen] = useState(false);

    const racers = racersOfCategory(session.party, category);
    const allNew = racerTypeFor(session.party, category) === "new";
    const selectedId = packageIdForCategory(item, category);
    const selected = getPackage(selectedId);
    // A bundle preselected off the Experiences shelf (session.preferredPackageId)
    // is NOT necessarily in today's eligible list — render it anyway, or the
    // guest has no way to see (or remove) what they're buying.
    const offered = bundlesFor(item, session, category);
    const bundles =
      selected && !offered.some((p) => p.id === selected.id) ? [selected, ...offered] : offered;
    const hero = bundles.find((p) => p.recommended) ?? null;
    const others = bundles.filter((p) => p !== hero);

    const packsOn = racePackTeaserVisible(session) && kioskRacePacksEnabled();
    const skus = packsOn ? kioskPackSkus() : [];
    const eligible = session.party.filter((m) => !!m.bmiPersonId);
    const picks = item.creditPacks ?? [];

    // Cheapest single race for this category, from the same registry the product
    // step prices its tier cards from — so the two screens can't quote different
    // money. A first-timer's baseline includes the licence they must buy anyway;
    // that's what makes the bundle deltas honest.
    const singles = (() => {
      if (!item.date) return [];
      const racerType = racerTypeFor(session.party, category);
      return combineTrackVariants(
        filterProducts(productsForSchedule(scheduleForDate(item.date), racerType), {
          racerType,
          adultCount: category === "adult" ? racers.length : 0,
          juniorCount: category === "junior" ? racers.length : 0,
          memberships: racers.flatMap((m) => m.memberships ?? []),
        }).filter((p) => p.category === category),
      ).filter((p) => !p.packType || p.packType === "none");
    })();
    const cheapestSingle = singles.length > 0 ? singles[0] : null;
    const baseline =
      cheapestSingle != null
        ? Math.min(...singles.map((p) => p.price)) + (allNew ? LICENSE_PRICE : 0)
        : null;

    const covered = coveredMembersPreview(item, session.party, item.date);
    const creditNames = racers
      .filter((m) => covered.get((m as { id: string }).id)?.source === "account-credits")
      .map((m) => (m as { firstName: string }).firstName);

    const dropBundle = () => {
      setSingleChosen(false);
      const { patch, removed } = clearPackageForCategory(item, category);
      onChange(patch);
      if (removed.some((h) => h.bmiLineId)) void releaseHeatBmiLines(session, removed);
    };

    const chooseBundle = (pkg: PackageDefinition) => {
      // Re-tapping the selected bundle is a no-op now that nothing auto-advances.
      if (pkg.id === selectedId) return;
      setSingleChosen(false);
      const { patch, removed } = clearPackageForCategory(item, category);
      onChange(
        category === "adult"
          ? { ...patch, packageIdAdult: pkg.id, productIdAdult: null, productTrackAdult: null }
          : { ...patch, packageIdJunior: pkg.id, productIdJunior: null, productTrackJunior: null },
      );
      if (removed.some((h) => h.bmiLineId)) void releaseHeatBmiLines(session, removed);
    };

    // Single races: clear any bundle (releasing its held heats) so page 2 comes
    // back, and mark the row chosen. Continue does the rest.
    const chooseSingle = () => {
      if (selectedId) dropBundle();
      setSingleChosen(true);
    };

    const money = (n: number) => `$${n.toFixed(2)}`;
    const perRacer = (pkg: PackageDefinition) => packagePerRacerPrice(pkg);
    const delta = (pkg: PackageDefinition) => (baseline != null ? perRacer(pkg) - baseline : null);

    const countBadge = (n: number, gold?: boolean) => (
      <span className="w-[116px] shrink-0 text-center">
        <span
          className={`block text-[34px] font-extrabold italic leading-none ${gold ? "text-[#FFD98A]" : ""}`}
        >
          {n}
        </span>
        <span
          className={`mt-1 block text-[13px] font-extrabold uppercase tracking-[0.14em] ${
            gold ? "text-[#FFD98A]/70" : "text-white/45"
          }`}
        >
          {t("payMode.raceWord", { count: n })}
        </span>
      </span>
    );

    return (
      <div className="mx-auto w-full max-w-[880px] space-y-3">
        {/* No eyebrow: the chrome above already stacks a brand row, the step
            progress and the step title ("ADULT RACE"). A fourth header line was
            pure air above the first tappable thing (owner 2026-08-04). */}
        <div>
          <h3 className="font-display text-[32px] leading-none uppercase">
            {allNew ? t("payMode.title.first") : t("payMode.title.today")}
          </h3>
          <p className="mt-1.5 text-[20px] leading-snug text-white/50">
            {allNew ? t("payMode.sub.first") : t("payMode.sub.today")}
          </p>
        </div>

        {creditNames.length > 0 && (
          <p className="rounded-2xl border border-[#00E2E5]/30 bg-[#00E2E5]/5 px-5 py-3 text-[19px] text-[#7FF0F1]">
            {t("payMode.credits", { names: creditNames.join(" & "), count: creditNames.length })}
          </p>
        )}

        {/* HERO — the house recommendation */}
        {hero && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => chooseBundle(hero)}
              aria-pressed={selectedId === hero.id}
              className={`relative flex w-full items-center gap-6 rounded-[22px] border-2 border-[#f0b341] bg-linear-to-br from-[#f0b341]/20 to-[#f0b341]/5 px-6 pt-7 pb-6 text-left ${
                selectedId === hero.id ? "ring-4 ring-[#f0b341]/45" : ""
              }`}
            >
              <span className="absolute -top-4 left-6 rounded-full bg-[#f0b341] px-4 py-1.5 text-[17px] font-extrabold uppercase italic text-[#241701]">
                {t("payMode.recommended")}
              </span>
              {countBadge(hero.races.length || 1, true)}
              <span className="min-w-0 flex-1">
                <span className="font-display block text-[34px] leading-tight uppercase">
                  {hero.name}
                </span>
                <span className="mt-2 block text-[22px] leading-snug text-white/70">
                  {bundleSay(t, hero)}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-[40px] font-extrabold italic leading-none tabular-nums">
                  {money(perRacer(hero))}
                </span>
                <span className="mt-1.5 block text-[17px] text-white/50">
                  {inclusions(t, hero)}
                </span>
              </span>
            </button>
            {selectedId === hero.id && (
              <button
                type="button"
                onClick={dropBundle}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 px-4 py-3 text-[17px] font-semibold text-white/60"
              >
                <span aria-hidden>✕</span>
                {t("racePackage.remove", { name: hero.name })}
              </button>
            )}
          </div>
        )}

        {/* Other bundles — thin rows carrying the delta */}
        {others.map((pkg) => {
          const d = delta(pkg);
          return (
            <div key={pkg.id} className="space-y-2">
              <button
                type="button"
                onClick={() => chooseBundle(pkg)}
                aria-pressed={selectedId === pkg.id}
                className={`flex w-full items-center gap-5 rounded-2xl border-2 px-6 py-4 text-left ${
                  selectedId === pkg.id
                    ? "border-[#00E2E5] bg-[#00E2E5]/7"
                    : "border-white/13 bg-white/[0.03]"
                }`}
              >
                {countBadge(pkg.races.length || 1)}
                <span className="min-w-0 flex-1">
                  <span className="block text-[25px] font-bold">{pkg.name}</span>
                  <span className="mt-0.5 block text-[19px] text-white/50">
                    {bundleSay(t, pkg)}
                  </span>
                </span>
                {d != null && d > 0 && (
                  <span className="shrink-0 rounded-full bg-[#f0b341]/20 px-3.5 py-1 text-[19px] font-extrabold italic whitespace-nowrap text-[#FFD98A]">
                    +{money(d)}
                  </span>
                )}
                <span className="shrink-0 text-[30px] font-extrabold italic whitespace-nowrap tabular-nums">
                  {money(perRacer(pkg))}
                </span>
              </button>
              {selectedId === pkg.id && (
                <button
                  type="button"
                  onClick={dropBundle}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 px-4 py-3 text-[17px] font-semibold text-white/60"
                >
                  <span aria-hidden>✕</span>
                  {t("racePackage.remove", { name: pkg.name })}
                </button>
              )}
            </div>
          );
        })}

        {/* The plain single race */}
        {cheapestSingle && baseline != null && (
          <button
            type="button"
            onClick={chooseSingle}
            aria-pressed={singleChosen}
            className={`flex w-full items-center gap-5 rounded-2xl border-2 px-6 py-4 text-left ${
              singleChosen ? "border-[#00E2E5] bg-[#00E2E5]/7" : "border-white/13 bg-white/[0.03]"
            }`}
          >
            {countBadge(1)}
            <span className="min-w-0 flex-1">
              <span className="block text-[25px] font-bold">{cheapestSingle.name}</span>
              <span className="mt-0.5 block text-[19px] text-white/50">
                {allNew ? t("payMode.single.qualifies") : t("payMode.single.today")}
              </span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block text-[30px] font-extrabold italic leading-none tabular-nums">
                {money(baseline)}
              </span>
              {allNew && (
                <span className="mt-1 block text-[16px] text-white/45">
                  {t("payMode.incl.prefix", { list: t("payMode.incl.license") })}
                </span>
              )}
            </span>
          </button>
        )}

        {/* Race packs — one line until tapped */}
        {packsOn && skus.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setPackOpen((o) => !o)}
              aria-expanded={packOpen}
              className={`flex w-full items-center gap-5 border-[1.5px] border-[#00E2E5]/32 bg-linear-to-br from-[#00E2E5]/8 to-[#00E2E5]/[0.02] px-6 py-4 text-left ${
                packOpen ? "rounded-t-2xl" : "rounded-2xl"
              }`}
            >
              <span className="font-display shrink-0 text-[24px] uppercase text-[#9DF6F7]">
                {t("payMode.pack.title")}
              </span>
              <span className="min-w-0 flex-1 text-[19px] text-white/50">
                {t("payMode.pack.sub", {
                  sizes: [...new Set(skus.map((p) => p.raceCount))].join(", "),
                })}
              </span>
              <span className="shrink-0 text-[21px] font-bold tabular-nums">
                {t("racePack.teaser.from", { price: money(skus[0].price) })}
              </span>
              <span aria-hidden className="shrink-0 text-[26px] text-[#9DF6F7]/70">
                {packOpen ? "⌄" : "›"}
              </span>
            </button>
            {packOpen && (
              <div className="rounded-b-2xl border-[1.5px] border-t-0 border-[#00E2E5]/32 bg-[#00E2E5]/[0.03] px-6 py-5">
                <RacePackPicker
                  skus={skus}
                  eligible={eligible}
                  picks={picks}
                  onChange={(next) => onChange({ creditPacks: next })}
                />
              </div>
            )}
          </div>
        )}

        {racers.length > 1 && (
          <p className="text-center text-[18px] text-white/40">
            {t("payMode.perRacer", {
              names: racers.map((m) => (m as { firstName: string }).firstName).join(" & "),
            })}
          </p>
        )}
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
