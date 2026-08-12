"use client";

/**
 * Race step — page 1 of 2: WHAT they're buying, before WHICH race.
 *
 * Owner-approved layout (2026-08-03/04, "option 1" after five passes; brought
 * to WEB 2026-08-10):
 *   ─ one line of qualification context ("everyone starts on a Starter race")
 *   ─ the HOUSE RECOMMENDATION as a hero card (registry `recommended` flag —
 *     the Ultimate Qualifier today), with its race count huge
 *   ─ every other bundle as a thin row carrying a +$delta against the cheapest
 *     way to race, because a first-timer's real decision is the difference,
 *     not the total
 *   ─ the plain single race as the last row
 *   ─ race packs collapsed to ONE line until tapped (kiosk + returning-racer
 *     web parties — the pack rail needs a BMI account to grant onto)
 *
 * TWO TYPE SCALES, one JSX tree: the kiosk reads standing up next to 112px
 * buttons (body ~21px, hero 34px, price 40px after .kiosk-zoom), the web is
 * mobile-heavy (375px). `KIOSK_S` is the owner-approved literals CHARACTER
 * FOR CHARACTER — never edit that map without a new owner sign-off; `WEB_S`
 * is mobile-first. The `satisfies` clause keeps the two slot-complete.
 *
 * Money is LIVE per bundle (usePackageAvailability → livePerRacerPrice, the
 * same derivations PackageCard uses — displayed = charged), rendering the
 * registry price instantly and swapping the live value in place. A bundle
 * whose two races can no longer fit today (packageBlockedToday) renders
 * disabled with the reason instead of dead-ending at the heat picker.
 *
 * Per CATEGORY, like the product and heat steps it precedes: a bundle is a
 * per-category purchase (`packageIdAdult` / `packageIdJunior`) and adult/junior
 * are separate SKUs at separate prices. Picking a bundle SKIPS page 2 (the
 * bundle owns the race) and lands on its heat picker; picking the single race —
 * or removing the bundle — brings page 2 back. `RaceProductStep.isVisible` reads
 * the same `payModeStepVisible` seam, so the two can never disagree.
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
  kioskRacePacksEnabled,
  packSkusForRaceDate,
} from "~/features/booking/service/race-pack-kiosk";
import { racerNeedsLicense } from "~/features/booking/service/license";
import { useT, type Translate } from "~/features/kiosk/i18n";
import { racePackTeaserVisible } from "./RacePackTeaser";
import { RacePackPicker } from "./RacePackPicker";
import { IncludedList } from "./PackageCard";
import {
  livePerRacerPrice,
  packageBlockedToday,
  usePackageAvailability,
} from "./usePackageAvailability";

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
  // A live limited-time bundle outranks the standing house recommendation for
  // the hero slot; `recommended` still decides among everything else, so the
  // Ultimate Qualifier takes the card straight back when the sale window
  // closes. Without the badge tier here, `eligiblePackages`' displayOrder is
  // discarded by this re-sort and a sale bundle lands in the thin rows below
  // the very card it is meant to headline.
  return [...list].sort(
    (a, b) =>
      Number(!!b.badge) - Number(!!a.badge) || Number(!!b.recommended) - Number(!!a.recommended),
  );
}

/**
 * Does page 1 exist for this category? Exported so the product step can drop the
 * bundle + pack blocks it moved here (and hide itself once a bundle is chosen)
 * without duplicating the rule — the two must never disagree. Runs on BOTH
 * kiosk and web (owner 2026-08-10); combo sessions never reach it (the
 * registry wraps this step hiddenInCombo, and that wrapper is the ONLY combo
 * guard for the bundles half — keep it).
 */
export function payModeStepVisible(
  item: RaceItem,
  session: Parameters<typeof racePackTeaserVisible>[0],
  category: Category,
): boolean {
  if (!item.date) return false;
  if (racersOfCategory(session.party, category).length === 0) return false;
  const hasPacks = racePackTeaserVisible(session, item.date);
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

/* ── Style maps ─────────────────────────────────────────────────────────────
 * KIOSK_S values are the owner-approved 2026-08-04 literals, verbatim — the
 * kiosk render must stay pixel-identical (verified by screenshot diff).
 * WEB_S is mobile-first: rows wrap, the hero stacks under `sm`, type sits on
 * the web flow's text-sm/base scale. Same slot set, enforced by `satisfies`.
 */
const KIOSK_S = {
  container: "mx-auto w-full max-w-[880px] space-y-2.5",
  title: "font-display text-[32px] leading-none uppercase",
  sub: "mt-1.5 text-[20px] leading-snug text-white/50",
  credits:
    "rounded-2xl border border-[#00E2E5]/30 bg-[#00E2E5]/5 px-5 py-3 text-[19px] text-[#7FF0F1]",
  heroWrap: "mt-4 space-y-2",
  heroBtn:
    "relative flex w-full items-center gap-6 rounded-[22px] border-2 border-[#f0b341] bg-linear-to-br from-[#f0b341]/20 to-[#f0b341]/5 px-5 pt-6 pb-5 text-left",
  heroRing: "ring-4 ring-[#f0b341]/45",
  heroPill:
    "absolute -top-4 left-6 rounded-full bg-[#f0b341] px-4 py-1.5 text-[17px] font-extrabold uppercase italic text-[#241701]",
  heroBody: "min-w-0 flex-1",
  heroName: "font-display block text-[30px] leading-tight uppercase",
  heroSay: "mt-1.5 block text-[20px] leading-snug text-white/70",
  heroPriceCol: "shrink-0 text-right",
  heroPrice: "block text-[36px] font-extrabold italic leading-none tabular-nums",
  heroIncl: "mt-1.5 block text-[17px] text-white/50",
  removeBtn:
    "flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 px-4 py-3 text-[17px] font-semibold text-white/60",
  badge: "w-[84px] shrink-0 text-center",
  badgeNum: "block text-[30px] font-extrabold italic leading-none",
  badgeWord: "mt-1 block text-[13px] font-extrabold uppercase tracking-[0.14em]",
  row: "flex w-full items-center gap-4 rounded-2xl border-2 px-5 py-3 text-left",
  rowSelected: "border-[#00E2E5] bg-[#00E2E5]/7",
  rowIdle: "border-white/13 bg-white/[0.03]",
  rowBody: "min-w-0 flex-1",
  rowName: "block text-[23px] font-bold",
  rowSay: "mt-0.5 block text-[19px] text-white/50",
  deltaPill:
    "shrink-0 rounded-full bg-[#f0b341]/20 px-3.5 py-1 text-[19px] font-extrabold italic whitespace-nowrap text-[#FFD98A]",
  rowPrice: "shrink-0 text-[30px] font-extrabold italic whitespace-nowrap tabular-nums",
  singlePriceCol: "shrink-0 text-right",
  singlePrice: "block text-[30px] font-extrabold italic leading-none tabular-nums",
  singleNote: "mt-1 block text-[16px] text-white/45",
  blockedNote: "mt-1 block text-[17px] leading-snug text-white/45",
  // Kiosk renders no included-disclosure (owner-approved layout) — the card
  // IS the button there, so these wrapper/footer slots are unused.
  heroCard: "",
  rowCard: "",
  inclToggle: "",
  inclBody: "",
  packBtn: "flex w-full items-center gap-4 border-[1.5px] px-5 py-3 text-left",
  packTitle: "font-display shrink-0 text-[24px] uppercase text-[#9DF6F7]",
  packSub: "min-w-0 flex-1 text-[19px] text-white/50",
  packPrice: "shrink-0 text-[21px] font-bold tabular-nums",
  packChevron: "shrink-0 text-[26px] text-[#9DF6F7]/70",
  packBody:
    "rounded-b-2xl border-[1.5px] border-t-0 border-[#00E2E5]/32 bg-[#00E2E5]/[0.03] px-5 py-4",
  perRacer: "text-center text-[18px] text-white/40",
} as const;

const WEB_S = {
  container: "mx-auto w-full max-w-2xl space-y-3",
  title: "font-display text-2xl uppercase leading-none sm:text-3xl",
  sub: "mt-1.5 text-sm leading-snug text-white/50",
  credits:
    "rounded-xl border border-[#00E2E5]/30 bg-[#00E2E5]/5 px-4 py-2.5 text-sm text-[#7FF0F1]",
  heroWrap: "mt-4 space-y-2",
  heroBtn:
    "flex w-full flex-col gap-3 px-4 pt-6 pb-4 text-left sm:flex-row sm:items-center sm:gap-5",
  heroRing: "ring-4 ring-[#f0b341]/45",
  heroPill:
    "absolute -top-3 left-4 rounded-full bg-[#f0b341] px-3 py-1 text-[11px] font-extrabold uppercase italic text-[#241701]",
  heroBody: "min-w-0 flex-1",
  heroName: "font-display block text-xl uppercase leading-tight sm:text-2xl",
  heroSay: "mt-1 block text-sm leading-snug text-white/70",
  heroPriceCol: "shrink-0 sm:text-right",
  heroPrice: "block text-2xl font-extrabold italic leading-none tabular-nums sm:text-3xl",
  heroIncl: "mt-1 block text-xs text-white/50",
  removeBtn:
    "flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 px-4 py-2.5 text-xs font-semibold text-white/60 transition-colors hover:border-red-400/40 hover:text-red-300",
  badge: "w-12 shrink-0 text-center",
  badgeNum: "block text-xl font-extrabold italic leading-none",
  badgeWord: "mt-0.5 block text-[9px] font-extrabold uppercase tracking-[0.14em]",
  row: "flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left",
  rowSelected: "border-[#00E2E5] bg-[#00E2E5]/7",
  rowIdle: "border-white/13 bg-white/[0.03]",
  rowBody: "min-w-0 flex-1 basis-36",
  rowName: "block text-base font-bold",
  rowSay: "mt-0.5 block text-sm text-white/50",
  deltaPill:
    "shrink-0 rounded-full bg-[#f0b341]/20 px-2.5 py-0.5 text-xs font-extrabold italic whitespace-nowrap text-[#FFD98A]",
  rowPrice:
    "ml-auto shrink-0 text-lg font-extrabold italic whitespace-nowrap tabular-nums sm:text-xl",
  singlePriceCol: "ml-auto shrink-0 sm:text-right",
  singlePrice: "block text-lg font-extrabold italic leading-none tabular-nums sm:text-xl",
  singleNote: "mt-1 block text-xs text-white/45",
  blockedNote: "mt-1 block text-xs leading-snug text-white/45",
  // The web card is a WRAPPER div (selection border/ring lives here) with the
  // select button + a "What's included" footer row INSIDE it — the kiosk
  // compact package card's grammar (owner 2026-08-10: the detached line under
  // the card read as an orphan).
  heroCard:
    "relative w-full rounded-2xl border-2 border-[#f0b341] bg-linear-to-br from-[#f0b341]/20 to-[#f0b341]/5",
  rowCard: "w-full rounded-xl border-2",
  inclToggle:
    "flex w-full items-center gap-2 border-t border-dashed border-white/10 px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-widest text-amber-300/90",
  inclBody: "px-4 pb-4",
  packBtn: "flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-[1.5px] px-4 py-3 text-left",
  packTitle: "font-display shrink-0 text-base uppercase text-[#9DF6F7]",
  packSub: "min-w-0 flex-1 basis-36 text-sm text-white/50",
  packPrice: "ml-auto shrink-0 text-sm font-bold tabular-nums",
  packChevron: "shrink-0 text-lg text-[#9DF6F7]/70",
  packBody:
    "rounded-b-xl border-[1.5px] border-t-0 border-[#00E2E5]/32 bg-[#00E2E5]/[0.03] px-4 py-3",
  perRacer: "text-center text-xs text-white/40",
} as const satisfies Record<keyof typeof KIOSK_S, string>;

const money = (n: number) => `$${n.toFixed(2)}`;

/** Live per-bundle pricing + the time gate — one hook per rendered bundle
 *  (that's why hero/row are components, not map bodies). Registry price
 *  renders instantly; the live value swaps in place, no spinner. */
function useBundlePricing(pkg: PackageDefinition, date: string | null, racerCount: number) {
  const { livePrices, heatsByRef } = usePackageAvailability(pkg, date, racerCount);
  const blocked = packageBlockedToday(pkg, heatsByRef);
  const perRacer = livePrices ? livePerRacerPrice(pkg, livePrices) : packagePerRacerPrice(pkg);
  return { blocked, perRacer };
}

/** WEB-only "What's included" footer — a row INSIDE the card under a dashed
 *  divider that expands PackageCard's checklist in place (the kiosk compact
 *  package card's grammar; owner 2026-08-10: the detached line under the card
 *  read as an orphan). A web guest can't ask staff what's in the bundle; the
 *  kiosk keeps the leaner owner-approved layout (S.inclToggle empty there).
 *  Sibling of the select button — a nested button is invalid HTML. */
function IncludedFooter({
  pkg,
  open,
  onToggle,
  t,
  S,
}: {
  pkg: PackageDefinition;
  open: boolean;
  onToggle: () => void;
  t: Translate;
  S: typeof WEB_S | typeof KIOSK_S;
}) {
  if (!S.inclToggle) return null;
  return (
    <>
      <button type="button" onClick={onToggle} aria-expanded={open} className={S.inclToggle}>
        <span
          aria-hidden
          className={`inline-block transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        >
          ›
        </span>
        {t("payMode.included.toggle")}
      </button>
      {open && (
        <div className={S.inclBody}>
          <IncludedList pkg={pkg} racers={1} />
        </div>
      )}
    </>
  );
}

function CountBadge({
  n,
  gold,
  t,
  S,
}: {
  n: number;
  gold?: boolean;
  t: Translate;
  S: typeof WEB_S | typeof KIOSK_S;
}) {
  return (
    <span className={S.badge}>
      <span className={`${S.badgeNum} ${gold ? "text-[#FFD98A]" : ""}`}>{n}</span>
      <span className={`${S.badgeWord} ${gold ? "text-[#FFD98A]/70" : "text-white/45"}`}>
        {t("payMode.raceWord", { count: n })}
      </span>
    </span>
  );
}

function HeroBundleCard({
  pkg,
  item,
  selected,
  onChoose,
  onDrop,
  racerCount,
  t,
  S,
}: {
  pkg: PackageDefinition;
  item: RaceItem;
  selected: boolean;
  onChoose: () => void;
  onDrop: () => void;
  racerCount: number;
  t: Translate;
  S: typeof WEB_S | typeof KIOSK_S;
}) {
  const { blocked, perRacer } = useBundlePricing(pkg, item.date, racerCount);
  const [inclOpen, setInclOpen] = useState(false);
  const selectBtn = (
    <button
      type="button"
      onClick={blocked ? undefined : onChoose}
      disabled={blocked && !selected}
      aria-pressed={selected}
      className={
        S.heroCard
          ? S.heroBtn
          : `${S.heroBtn} ${selected ? S.heroRing : ""} ${blocked ? "opacity-60" : ""}`
      }
    >
      {/* The hero pill names WHY this card is the hero — and says "selected"
          when it IS the pick. The hero's gold treatment is permanent, so
          without this it reads as chosen even when the guest has picked
          something else below it (owner 2026-08-12: "Ultimate Qualifier always
          seems selected and it's not"). `pkg.badge` is the registry's English
          marker used only to branch; the visible words always come from the
          catalog, so a Spanish kiosk never leaks it. */}
      <span className={S.heroPill}>
        {selected
          ? t("payMode.selected")
          : pkg.badge
            ? t("payMode.flashSale")
            : t("payMode.recommended")}
      </span>
      <CountBadge n={pkg.races.length || 1} gold t={t} S={S} />
      <span className={S.heroBody}>
        <span className={S.heroName}>{pkg.name}</span>
        <span className={S.heroSay}>{bundleSay(t, pkg)}</span>
        {blocked && (
          <span className={S.blockedNote}>{t("payMode.blocked", { name: pkg.name })}</span>
        )}
      </span>
      <span className={S.heroPriceCol}>
        <span className={S.heroPrice}>{money(perRacer)}</span>
        <span className={S.heroIncl}>{inclusions(t, pkg)}</span>
      </span>
    </button>
  );
  return (
    // mt-4 clears the "recommended" pill: it hangs above the card border and
    // was covering the intro line (owner 2026-08-04).
    <div className={S.heroWrap}>
      {S.heroCard ? (
        // WEB: the wrapper div is the card (ring/dim live here); the footer
        // disclosure sits inside the same card, under a dashed divider.
        <div
          className={`${S.heroCard} ${selected ? S.heroRing : ""} ${blocked ? "opacity-60" : ""}`}
        >
          {selectBtn}
          {!blocked && (
            <IncludedFooter
              pkg={pkg}
              open={inclOpen}
              onToggle={() => setInclOpen((o) => !o)}
              t={t}
              S={S}
            />
          )}
        </div>
      ) : (
        // KIOSK: the button IS the card — the owner-approved 8/04 layout,
        // untouched.
        selectBtn
      )}
      {selected && (
        <button type="button" onClick={onDrop} className={S.removeBtn}>
          <span aria-hidden>✕</span>
          {t("racePackage.remove", { name: pkg.name })}
        </button>
      )}
    </div>
  );
}

function BundleRow({
  pkg,
  item,
  selected,
  onChoose,
  onDrop,
  racerCount,
  baseline,
  t,
  S,
}: {
  pkg: PackageDefinition;
  item: RaceItem;
  selected: boolean;
  onChoose: () => void;
  onDrop: () => void;
  racerCount: number;
  baseline: number | null;
  t: Translate;
  S: typeof WEB_S | typeof KIOSK_S;
}) {
  const { blocked, perRacer } = useBundlePricing(pkg, item.date, racerCount);
  const [inclOpen, setInclOpen] = useState(false);
  const d = baseline != null ? perRacer - baseline : null;
  const selectBtn = (
    <button
      type="button"
      onClick={blocked ? undefined : onChoose}
      disabled={blocked && !selected}
      aria-pressed={selected}
      className={
        S.rowCard
          ? S.row
          : `${S.row} ${selected ? S.rowSelected : S.rowIdle} ${blocked ? "opacity-60" : ""}`
      }
    >
      <CountBadge n={pkg.races.length || 1} t={t} S={S} />
      <span className={S.rowBody}>
        <span className={S.rowName}>{pkg.name}</span>
        <span className={S.rowSay}>{bundleSay(t, pkg)}</span>
        {blocked && (
          <span className={S.blockedNote}>{t("payMode.blocked", { name: pkg.name })}</span>
        )}
      </span>
      {!blocked && d != null && d > 0 && <span className={S.deltaPill}>+{money(d)}</span>}
      <span className={S.rowPrice}>{money(perRacer)}</span>
    </button>
  );
  return (
    <div className="space-y-2">
      {S.rowCard ? (
        <div
          className={`${S.rowCard} ${selected ? S.rowSelected : S.rowIdle} ${blocked ? "opacity-60" : ""}`}
        >
          {selectBtn}
          {!blocked && (
            <IncludedFooter
              pkg={pkg}
              open={inclOpen}
              onToggle={() => setInclOpen((o) => !o)}
              t={t}
              S={S}
            />
          )}
        </div>
      ) : (
        selectBtn
      )}
      {selected && (
        <button type="button" onClick={onDrop} className={S.removeBtn}>
          <span aria-hidden>✕</span>
          {t("racePackage.remove", { name: pkg.name })}
        </button>
      )}
    </div>
  );
}

function makePayModeComponent(category: Category): StepDef<RaceItem>["Component"] {
  const PayMode: StepDef<RaceItem>["Component"] = ({ item, session, onChange }) => {
    const t = useT();
    const kiosk = !!session.context?.kiosk;
    const S = kiosk ? KIOSK_S : WEB_S;
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

    const packsOn = racePackTeaserVisible(session, item.date) && kioskRacePacksEnabled();
    const skus = packsOn ? packSkusForRaceDate(item.date) : [];
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
    // WHO owes a licence, verified (service/license.ts) — not "is the whole party
    // new". A mixed group used to see a bare $20.99 with no mention of the $4.99
    // each first-timer adds at checkout (owner 2026-08-04).
    const owesLicense = racers.filter((m) => racerNeedsLicense(m));
    // NEVER show the product name here: it presumes the tier the guest hasn't
    // picked yet and leaks the schedule variant ("Starter Race Mega") — owner
    // 2026-08-04. The row names neither the tier nor a price it can be sure of:
    // page 2 picks the tier, and credits / comps / a pack can take today to $0.
    const allOweLicense = racers.length > 0 && owesLicense.length === racers.length;
    const baseline =
      cheapestSingle != null
        ? Math.min(...singles.map((p) => p.price)) + (allOweLicense ? LICENSE_PRICE : 0)
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
    //
    // A credit pack is the OTHER way to pay for the same race, so the two can't
    // both be lit (owner 2026-08-04). Choosing "pay per race" drops the pack
    // picks; choosing a pack clears this row below. Nothing is charged either
    // way until checkout, so this only edits session pointers.
    const chooseSingle = () => {
      if (selectedId) dropBundle();
      if (picks.length > 0) onChange({ creditPacks: undefined });
      setPackOpen(false);
      setSingleChosen(true);
    };

    return (
      <div className={S.container}>
        {/* No eyebrow: the chrome above already stacks a brand row, the step
            progress and the step title ("ADULT RACE"). A fourth header line was
            pure air above the first tappable thing (owner 2026-08-04). */}
        <div>
          <h3 className={S.title}>
            {allNew ? t("payMode.title.first") : t("payMode.title.today")}
          </h3>
          <p className={S.sub}>{allNew ? t("payMode.sub.first") : t("payMode.sub.today")}</p>
        </div>

        {creditNames.length > 0 && (
          <p className={S.credits}>
            {t("payMode.credits", { names: creditNames.join(" & "), count: creditNames.length })}
          </p>
        )}

        {/* HERO — the house recommendation */}
        {hero && (
          <HeroBundleCard
            pkg={hero}
            item={item}
            selected={selectedId === hero.id}
            onChoose={() => chooseBundle(hero)}
            onDrop={dropBundle}
            racerCount={racers.length}
            t={t}
            S={S}
          />
        )}

        {/* Other bundles — thin rows carrying the delta */}
        {others.map((pkg) => (
          <BundleRow
            key={pkg.id}
            pkg={pkg}
            item={item}
            selected={selectedId === pkg.id}
            onChoose={() => chooseBundle(pkg)}
            onDrop={dropBundle}
            racerCount={racers.length}
            baseline={baseline}
            t={t}
            S={S}
          />
        ))}

        {/* The plain single race */}
        {cheapestSingle && baseline != null && (
          <button
            type="button"
            onClick={chooseSingle}
            aria-pressed={singleChosen}
            // rowCard carries the border-2/rounded on web (the bundle rows get
            // them from their wrapper div) — without it the selected state was
            // an invisible 3%→7% bg tint (owner 2026-08-10: "doesn't highlight").
            className={`${S.rowCard} ${S.row} ${singleChosen ? S.rowSelected : S.rowIdle}`}
          >
            <CountBadge n={1} t={t} S={S} />
            <span className={S.rowBody}>
              {/* Never names a TIER: the tier is what page 2 asks for, and a
                  guest who hasn't been there yet reads "Starter race" as a
                  product they're being sold (owner 2026-08-04). */}
              <span className={S.rowName}>{t("payMode.single.anyRace")}</span>
              {/* This row is ALSO the only path for a guest whose race is already
                  covered — banked credits, a comp, or the pack they just added —
                  so it can't read as "pay again" (owner 2026-08-04). The web
                  variant doesn't mention packs until the pack rail is on. */}
              <span className={S.rowSay}>
                {kiosk || packsOn ? t("payMode.single.orUse") : t("payMode.single.orUse.web")}
              </span>
            </span>
            <span className={S.singlePriceCol}>
              {/* Always "from": the tiers on offer can differ in price, and
                  credits / comps / a pack can take it to $0. `baseline` keeps the
                  licence in it when every racer owes one, so the +$ deltas on the
                  bundle rows above still add up against this number. */}
              <span className={S.singlePrice}>
                {t("payMode.single.fromRacer", { price: money(baseline) })}
              </span>
              {allOweLicense ? (
                <span className={S.singleNote}>
                  {t("payMode.incl.prefix", { list: t("payMode.incl.license") })}
                </span>
              ) : owesLicense.length > 0 ? (
                <span className={S.singleNote}>
                  {t("payMode.license.plus", {
                    price: money(LICENSE_PRICE),
                    names: owesLicense
                      .map((m) => (m as { firstName: string }).firstName)
                      .join(" & "),
                  })}
                </span>
              ) : null}
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
              aria-pressed={picks.length > 0}
              className={`${S.packBtn} ${
                picks.length > 0
                  ? "border-[#00E2E5] bg-[#00E2E5]/10"
                  : "border-[#00E2E5]/32 bg-linear-to-br from-[#00E2E5]/8 to-[#00E2E5]/[0.02]"
              } ${packOpen ? "rounded-t-2xl" : "rounded-2xl"}`}
            >
              <span className={S.packTitle}>{t("payMode.pack.title")}</span>
              <span className={S.packSub}>
                {t("payMode.pack.sub", {
                  sizes: [...new Set(skus.map((p) => p.raceCount))].join(", "),
                })}
              </span>
              <span className={S.packPrice}>
                {picks.length > 0
                  ? t("payMode.pack.chosen", { count: picks.length })
                  : t("racePack.teaser.from", { price: money(skus[0].price) })}
              </span>
              <span aria-hidden className={S.packChevron}>
                {packOpen ? "⌄" : "›"}
              </span>
            </button>
            {packOpen && (
              <div className={S.packBody}>
                <RacePackPicker
                  skus={skus}
                  eligible={eligible}
                  ineligibleNames={session.party
                    .filter((m) => !m.bmiPersonId)
                    .map((m) => (m as { firstName: string }).firstName)}
                  picks={picks}
                  onChange={(next) => {
                    // A pack IS the payment for today's race — it cancels the
                    // "pay per race" row rather than stacking with it.
                    if ((next?.length ?? 0) > 0) setSingleChosen(false);
                    onChange({ creditPacks: next });
                  }}
                />
              </div>
            )}
          </div>
        )}

        {racers.length > 1 && (
          <p className={S.perRacer}>
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
