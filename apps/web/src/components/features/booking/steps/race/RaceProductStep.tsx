"use client";

import { useMemo, useState } from "react";
import { IconDiscount2 } from "@tabler/icons-react";
import type { RaceItem, StepDef } from "~/features/booking";
import { membershipDiscountsForNames } from "~/features/booking/service/membership-discounts";
import {
  filterProducts,
  productsForSchedule,
  combineTrackVariants,
  type RaceProduct,
  type RaceTier,
  type RacerType,
} from "~/features/booking/service/race-products";
import { scheduleForDate, LICENSE_PRICE } from "~/features/booking/service/race-pricing";
import { eligiblePackages } from "~/features/booking/service/packages";
import { ComboUpsellCard } from "../combo/ComboUpsellCard";
import { PackageCard } from "./PackageCard";

/**
 * Race step — pick the product for ONE category (adult or junior).
 *
 * v1 parity: full port of `apps/web/app/book/race/components/ProductPicker.tsx`.
 * Mirrors:
 *   - Title differs by racerType: "Pick Your Starter Race" (new) vs
 *     "Choose Your Race" (existing)
 *   - Tier descriptions render under name + tier label
 *   - Multi-track products (parent has `trackProducts`) collapse to a single
 *     merged card; selecting one shows BOTH tracks on the heat grid (no track
 *     lock, like the Ultimate combo) — the customer picks any heat regardless
 *     of track
 *   - Per-card itemized breakdown for new-racer single-race picks
 *     (race + license × racers = total)
 *   - 3-pack badge + "$X / race" footnote for combo packs
 *   - "No races available for this date and party" empty state
 *
 * NOT yet ported (deferred follow-up commits flagged at PR review):
 *   - Premium Packages (`PackageDefinition` from `lib/packages.ts`) —
 *     needs the full packages registry + live BMI pricing port. The
 *     v2 race step ships without bundled packages; customers still get
 *     individual races + 3-packs.
 *   - "Showing tier and below" qualification banner — depends on
 *     per-racer BMI verification data (the verification flow is a
 *     deferred follow-up PR, so the data source doesn't exist yet).
 *
 * Promo behavior per `booking_v2_promo_integration.md`: filter-at-start
 * only; this step does NOT filter by promo scope. Discount sticks at
 * checkout regardless of product picked.
 */

type Category = "adult" | "junior";

// Tier accent hues — section-heading text (lightened for readability on the
// dark ground) + the card's left-border accent. Price text is WHITE everywhere
// (the old per-tier price colors read as random); amber is reserved for the
// pack "Save $X" chip. (2026-07-02 redesign — Option C mockup.)
const TIER_HEADING: Record<RaceTier, string> = {
  starter: "text-[#00E2E5]",
  intermediate: "text-[#B39DFF]",
  pro: "text-[#FF7A76]",
};
const TIER_ACCENT: Record<RaceTier, string> = {
  starter: "#00E2E5",
  intermediate: "#8652FF",
  pro: "#E53935",
};

const TIER_LABEL: Record<RaceTier, string> = {
  starter: "Starter",
  intermediate: "Intermediate",
  pro: "Pro",
};

// One-liners. Qualification/ages moved to TIER_META (rendered in the section
// header, not buried in a paragraph); the first-visit license copy moved to
// NEW_RACER_LICENSE_NOTE so returning racers never see it.
const TIER_DESCRIPTIONS: Record<RaceTier, string> = {
  starter: "Fun, fast, and where every racer begins.",
  intermediate: "Higher speed unlock — a real competitive karting experience.",
  pro: "Our fastest karts — maximum performance for proven racers.",
};

/** Right side of each tier's section header. */
const TIER_META: Record<RaceTier, string> = {
  starter: "Everyone starts here",
  intermediate: "Ages 13+ · Starter qualification",
  pro: "Intermediate qualification",
};

/** Junior screens drop the adult age line — junior racers are under it by
 *  definition; the qualification part still applies. */
function tierMeta(tier: RaceTier, category: Category): string {
  if (category === "junior" && tier === "intermediate") return "Starter qualification";
  return TIER_META[tier];
}

/** Shown only on the NEW-racer Starter card (their whole product list). */
const NEW_RACER_LICENSE_NOTE =
  "First visit? Your FastTrax racing license is bundled — helmets, app tracking, head sock, and waived booking fees included.";

const TIER_ORDER: Record<RaceTier, number> = { starter: 0, intermediate: 1, pro: 2 };

/** Track dot hues for the "Runs on …" line (replaces the bare track chips). */
const TRACK_DOT: Record<string, string> = {
  Red: "#E53935",
  Blue: "#2196F3",
  Mega: "#A855F7",
};

function racersOfCategory(
  party: { category?: Category; isNewRacer: boolean; memberships?: string[] }[],
  category: Category,
): { category?: Category; isNewRacer: boolean; memberships?: string[] }[] {
  return party.filter((m) => (m.category ?? "adult") === category);
}

function isMultiTrack(product: RaceProduct): boolean {
  return !!product.trackProducts && Object.keys(product.trackProducts).length > 1;
}

function groupByTier(products: RaceProduct[]): [RaceTier, RaceProduct[]][] {
  const groups = new Map<RaceTier, RaceProduct[]>();
  for (const p of products) {
    const list = groups.get(p.tier) ?? [];
    list.push(p);
    groups.set(p.tier, list);
  }
  return [...groups.entries()].sort(([a], [b]) => TIER_ORDER[a] - TIER_ORDER[b]);
}

function makeProductStepComponent(category: Category): StepDef<RaceItem>["Component"] {
  const Component: StepDef<RaceItem>["Component"] = ({ item, session, onChange }) => {
    // KIOSK ONLY: packs render as compact teaser accordions (owner 2026-07-18 —
    // the rich cards pushed single races two screens down the portrait kiosk).
    // One pack's details open at a time. Web renders the rich cards unchanged.
    const kioskCompactPacks = !!session.context?.kiosk;
    const [openPackDetails, setOpenPackDetails] = useState<string | null>(null);
    if (!item.date) {
      return (
        <div className="text-center text-sm text-white/50">
          Pick a date first — that determines which races are available.
        </div>
      );
    }

    const racersInCategory = racersOfCategory(session.party, category);
    const racerCount = racersInCategory.length;
    if (racerCount === 0) {
      return (
        <div className="text-center text-sm text-white/50">No {category} racers in this party.</div>
      );
    }

    // racerType drives the product SET + tier gating. Use the NEW-racer flow
    // (Starter only + license bundle) ONLY when EVERY racer is new. A MIXED party
    // (e.g. a returning Pro racer + a new racer) uses the EXISTING flow so the
    // list spans every tier up to the highest-qualifying racer's rating. The new
    // racer still gets their license (added per `isNewRacer` at charge/book time)
    // and is crossed out of any heat above Starter in the racer selector.
    const allNew = racersInCategory.every((m) => m.isNewRacer);
    const racerType: RacerType = allNew ? "new" : "existing";

    // Aggregate memberships across this category's verified racers. v1
    // `filterProducts` gates Intermediate/Pro tier visibility on whether
    // the party has any member with that membership — so we pass the
    // union of every category racer's memberships. Without this, the
    // returning-racer flow defaults to Starter-only, hiding 3-Packs
    // and higher-tier products.
    const memberships = racersInCategory.flatMap((m) => m.memberships ?? []);

    // Heats already added for this category (via the "Add another race" loop, which
    // returns here with the product cleared). Drives the continue/add-more banner.
    const categoryHeatCount = item.heats.filter((h) => {
      if (!h.heatId || !h.assignedTo) return false;
      const m = session.party.find((p) => p.id === h.assignedTo);
      return !!m && (m.category ?? "adult") === category;
    }).length;

    const products = useMemo(() => {
      const schedule = scheduleForDate(item.date as string);
      const all = productsForSchedule(schedule, racerType);
      const filtered = filterProducts(all, {
        racerType,
        adultCount: category === "adult" ? racerCount : 0,
        juniorCount: category === "junior" ? racerCount : 0,
        memberships,
      }).filter((p) => p.category === category);
      // Collapse Red+Blue single races into one combined card — the heat grid
      // then shows BOTH tracks (like the Ultimate combo). Combos, single-track
      // (Mega) and junior (Blue-only) pass through unchanged.
      return combineTrackVariants(filtered);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [item.date, racerType, racerCount, memberships.join("|")]);

    const sorted = [...products].sort((a, b) => {
      const ta = TIER_ORDER[a.tier];
      const tb = TIER_ORDER[b.tier];
      if (ta !== tb) return ta - tb;
      return (a.raceCount ?? 1) - (b.raceCount ?? 1);
    });

    const packages = useMemo(() => {
      const schedule = scheduleForDate(item.date as string);
      return eligiblePackages({ racerType, schedule, category });
    }, [item.date, racerType]);

    // Package selection lives on item.packageId so back-nav doesn't lose it
    // AND so saveBookingDetails can write it to /api/booking-record (which
    // feeds sales_log.package_id via the v1 confirmation page).
    const selectedPackageId = item.packageId;

    const selectedProductId = category === "adult" ? item.productIdAdult : item.productIdJunior;

    const setProductWithTrack = (productId: string, track: string | null) =>
      onChange(
        category === "adult"
          ? { productIdAdult: productId, productTrackAdult: track }
          : { productIdJunior: productId, productTrackJunior: track },
      );

    const handleCardClick = (product: RaceProduct) => {
      // Multi-track products — combined single races AND mixed-track combo packs
      // (3-Packs) — are NOT track-locked: selecting one leaves the track open so
      // the heat grid shows BOTH tracks (like the Ultimate combo) and the customer
      // picks any heat(s) regardless of track. Single-track products carry theirs.
      if (isMultiTrack(product)) {
        setProductWithTrack(product.productId, null);
        return;
      }
      setProductWithTrack(product.productId, product.track);
    };

    if (products.length === 0) {
      return (
        <div className="py-8 text-center">
          <p className="text-sm text-white/40">
            No races available for this date and party. Try a different date.
          </p>
        </div>
      );
    }

    // Show category banner when the party spans BOTH adults + juniors
    // so the customer knows which side of the wizard they're on. v1
    // surfaces this same banner (page.tsx:2107-2138) above ProductPicker;
    // we dropped it during the strict-parity reverts but it's needed
    // when there's any chance of category confusion.
    const hasAdults = session.party.some((m) => (m.category ?? "adult") === "adult");
    const hasJuniors = session.party.some((m) => m.category === "junior");
    const showCategoryBanner = hasAdults && hasJuniors;

    // Per-racer membership racing discount (e.g. Employee Pass 50%, League Racer
    // 20%) — shown only for the racers in THIS category who hold it; others on
    // the bill aren't discounted. Applied for real at checkout (charge-line split).
    const discountRacers = session.party
      .filter((m) => (m.category ?? "adult") === category)
      .map((m) => {
        let pct = 0;
        let label: string | null = null;
        for (const d of membershipDiscountsForNames(m.memberships ?? [])) {
          if (d.categories.includes("racing") && d.percentOff > pct) {
            pct = d.percentOff;
            label = d.label;
          }
        }
        return pct > 0 ? { name: m.firstName, pct, label } : null;
      })
      .filter((x): x is { name: string; pct: number; label: string | null } => x != null);

    return (
      <div className="space-y-6">
        {showCategoryBanner && (
          <div
            className={`rounded-xl border-2 p-4 text-center ${
              category === "adult"
                ? "border-[#00E2E5]/50 bg-[#00E2E5]/10"
                : "border-amber-400/50 bg-amber-400/10"
            }`}
          >
            <p
              className={`font-display text-xl uppercase tracking-widest ${
                category === "adult" ? "text-[#00E2E5]" : "text-amber-400"
              }`}
            >
              {category === "adult" ? "Adult Races" : "Junior Races"}
            </p>
            <p className="mt-1 text-sm text-white/50">
              Pick a race for your {racerCount} {category}
              {racerCount !== 1 ? " racers" : " racer"}
            </p>
          </div>
        )}

        <div className="space-y-2 text-center">
          {/* v1 ProductPicker:121-130 verbatim — same titles for adult + junior */}
          <h3 className="font-display text-2xl tracking-widest text-white uppercase">
            {racerType === "new" ? "Pick Your Starter Race" : "Choose Your Race"}
          </h3>
          <p className="mx-auto max-w-md text-sm text-white/40">
            {racerType === "new"
              ? "All first-time racers start here. Pick the race that fits your group."
              : "Select from races you've qualified for."}
          </p>
        </div>

        {/* Ultimate VIP upsell (owner ask) — once per flow, on the first
            category step. $X more = combo price vs the cheapest single race
            (+ license for new racers, who buy one regardless). NOT on the
            kiosk: the card upgrades via window.location to /book/combo (a web
            navigation that escapes the kiosk shell — owner 2026-07-18 "brings
            you to website"); the kiosk sells the Ultimate VIP on its
            Experiences shelf instead. */}
        {!session.context?.kiosk &&
          (category === "adult" || !hasAdults) &&
          (() => {
            const singles = sorted.filter((p) => !p.packType || p.packType === "none");
            const minRaceCents = singles.length
              ? Math.min(...singles.map((p) => Math.round(p.price * 100)))
              : null;
            const baselineCents =
              minRaceCents != null
                ? minRaceCents + (racerType === "new" ? Math.round(LICENSE_PRICE * 100) : 0)
                : null;
            return (
              <ComboUpsellCard
                session={session}
                date={item.date}
                baselineCents={baselineCents}
                baselineLabel={racerType === "new" ? "a single race + license" : "a single race"}
              />
            );
          })()}

        {discountRacers.length > 0 && (
          <div className="mx-auto max-w-md space-y-1 rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-center text-sm text-amber-300">
            {discountRacers.map((r) => (
              <p key={r.name} className="flex items-center justify-center gap-1.5">
                <IconDiscount2 size={15} aria-hidden className="shrink-0" />
                <span>
                  <span className="font-semibold">{r.label ?? "Member"}</span>: {r.pct}% off{" "}
                  {r.name}&apos;s races — applied at checkout
                </span>
              </p>
            ))}
          </div>
        )}

        {categoryHeatCount > 0 && (
          <div className="mx-auto max-w-md rounded-xl border border-[#00E2E5]/30 bg-[#00E2E5]/5 p-3 text-center text-sm text-[#00E2E5]">
            You&apos;ve added {categoryHeatCount} {category} race
            {categoryHeatCount === 1 ? "" : "s"} — pick another below to add more, or hit Continue
            to move on.
          </div>
        )}

        {packages.length > 0 && (
          <div className="space-y-3">
            {packages.map((pkg) => (
              <PackageCard
                key={pkg.id}
                pkg={pkg}
                racerCount={racerCount}
                date={item.date}
                isSelected={selectedPackageId === pkg.id}
                compact={kioskCompactPacks}
                detailsOpen={openPackDetails === pkg.id}
                onToggleDetails={() =>
                  setOpenPackDetails((cur) => (cur === pkg.id ? null : pkg.id))
                }
                onSelect={() => {
                  // Persist the package pick on item state so back-nav
                  // doesn't lose it + so saveBookingDetails forwards it
                  // to the booking-record (drives sales_log.package_id).
                  // Clearing individual product pick keeps the cart shape
                  // consistent — package picks own their own race selections.
                  onChange(
                    category === "adult"
                      ? {
                          packageId: pkg.id,
                          productIdAdult: null,
                          productTrackAdult: null,
                        }
                      : {
                          packageId: pkg.id,
                          productIdJunior: null,
                          productTrackJunior: null,
                        },
                  );
                }}
              />
            ))}
            {/* Kiosk: brighter divider — at arm's length the /30 version read as
                nearly invisible, so guests never realized singles were below. */}
            <div className="flex items-center gap-3 py-2">
              <div className={`h-px flex-1 ${kioskCompactPacks ? "bg-white/25" : "bg-white/10"}`} />
              <span
                className={`text-xs uppercase tracking-wider ${
                  kioskCompactPacks ? "font-bold text-white/60" : "text-white/30"
                }`}
              >
                or pick a single race
              </span>
              <div className={`h-px flex-1 ${kioskCompactPacks ? "bg-white/25" : "bg-white/10"}`} />
            </div>
          </div>
        )}

        <div className="space-y-6">
          {groupByTier(sorted).map(([tier, tierProducts]) => {
            // A tier carries at most one single race (Red+Blue collapsed by
            // combineTrackVariants, or a lone Mega/junior product) and at most
            // one 3-pack. They render as ONE card — the pack is a pricing
            // option, not a competing product. `extras` is defensive: any
            // unexpected additional product still gets its own simple card.
            const single = tierProducts.find((p) => p.packType !== "combo");
            const pack = tierProducts.find((p) => p.packType === "combo");
            const extras = tierProducts.filter((p) => p !== single && p !== pack);
            return (
              <div key={tier}>
                <div className="mb-2 flex items-center gap-2.5">
                  <span
                    className={`text-xs font-bold tracking-[0.16em] uppercase ${TIER_HEADING[tier]}`}
                  >
                    {TIER_LABEL[tier]}
                  </span>
                  <div className="h-px flex-1 bg-white/10" />
                  <span className="text-xs whitespace-nowrap text-white/35">
                    {tierMeta(tier, category)}
                  </span>
                </div>
                <div className="grid gap-3">
                  <TierCard
                    single={single}
                    pack={pack}
                    selectedProductId={selectedProductId}
                    onSelect={handleCardClick}
                    racerType={racerType}
                    racerCount={racerCount}
                  />
                  {extras.map((p) => (
                    <TierCard
                      key={p.productId}
                      single={p}
                      selectedProductId={selectedProductId}
                      onSelect={handleCardClick}
                      racerType={racerType}
                      racerCount={racerCount}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };
  return Component;
}

/** Track names a product runs on (combined cards carry trackProducts), in the
 *  house order Red → Blue → Mega (trackProducts key order varies by catalog). */
const TRACK_SORT: Record<string, number> = { Red: 0, Blue: 1, Mega: 2 };
function trackList(product: RaceProduct): string[] {
  const tracks = product.trackProducts
    ? Object.keys(product.trackProducts)
    : product.track
      ? [product.track]
      : [];
  return tracks.sort((a, b) => (TRACK_SORT[a] ?? 9) - (TRACK_SORT[b] ?? 9));
}

/** "Runs on Red + Blue — pick your track with your heat time" with colored
 *  dots. Replaces the old bare track chips, which read as unexplained tags. */
function TrackLine({ product }: { product: RaceProduct }) {
  const tracks = trackList(product);
  if (tracks.length === 0) return null;
  return (
    <div className="mt-2 flex items-center gap-1.5 text-xs text-white/35">
      {tracks.map((t) => (
        <span
          key={t}
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: TRACK_DOT[t] ?? "#999" }}
        />
      ))}
      <span className="ml-0.5">
        {tracks.length > 1
          ? `Runs on ${tracks.join(" + ")} — pick your track with your heat time`
          : `Runs on ${tracks[0]} Track`}
      </span>
    </div>
  );
}

/**
 * One card per tier. When the tier has a 3-pack, the Single / 3-Pack choice
 * renders as two selectable columns INSIDE the card (Option C mockup) — the
 * pack is a pricing option, not a competing product. Tiers without a pack
 * (Starter, junior, weekend Pro) render as a simple full-card button.
 * Selection semantics are unchanged: each column/card still selects its own
 * RaceProduct via the parent's handleCardClick, so the heat grid and the
 * pack's raceCount=3 flow work exactly as before.
 */
function TierCard({
  single,
  pack,
  selectedProductId,
  onSelect,
  racerType,
  racerCount,
}: {
  single?: RaceProduct;
  pack?: RaceProduct;
  selectedProductId: string | null | undefined;
  onSelect: (product: RaceProduct) => void;
  racerType: RacerType;
  racerCount: number;
}) {
  const primary = (single ?? pack)!;
  const tier = primary.tier;
  const singleSelected = !!single && selectedProductId === single.productId;
  const packSelected = !!pack && selectedProductId === pack.productId;
  const isSelected = singleSelected || packSelected;
  const racers = Math.max(1, racerCount);

  const showNewBreakdown = !!single && single.price > 0 && racerType === "new";
  const licensePerRacer = showNewBreakdown ? LICENSE_PRICE : 0;
  const groupTotal = ((single?.price ?? 0) + licensePerRacer) * racers;

  const cardShell = `relative w-full rounded-xl border p-4 transition-all duration-200 ${
    isSelected ? "border-[#00E2E5] bg-[#00E2E5]/5" : "border-white/10 bg-white/5"
  }`;
  const accentStyle = {
    borderLeftWidth: 3,
    borderLeftColor: isSelected ? "#00E2E5" : TIER_ACCENT[tier],
  };
  const selectedFlag = isSelected ? (
    <span className="absolute -top-2.5 right-3.5 rounded-full bg-[#00E2E5] px-2.5 py-0.5 text-[10px] font-extrabold tracking-[0.12em] text-[#000418] uppercase">
      Selected
    </span>
  ) : null;

  // ── Simple card (no Single-vs-Pack choice): the whole card is the button.
  if (!single || !pack) {
    const product = primary;
    return (
      <button
        type="button"
        onClick={() => onSelect(product)}
        className={`${cardShell} text-left ${isSelected ? "" : "hover:border-white/30 hover:bg-white/8"}`}
        style={accentStyle}
      >
        {selectedFlag}
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[15px] font-bold text-white">{product.name}</span>
          {product.price > 0 && (
            <span className="text-[15px] font-extrabold whitespace-nowrap text-white tabular-nums">
              ${(showNewBreakdown ? groupTotal : product.price).toFixed(2)}
              {!showNewBreakdown && product.packType !== "combo" && (
                <span className="text-xs font-medium text-white/40"> / racer</span>
              )}
            </span>
          )}
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-white/50">{TIER_DESCRIPTIONS[tier]}</p>
        {racerType === "new" && tier === "starter" && (
          <p className="mt-1.5 text-xs leading-relaxed text-[#00E2E5]/80">
            {NEW_RACER_LICENSE_NOTE}
          </p>
        )}
        <TrackLine product={product} />

        {showNewBreakdown && single && (
          <div className="mt-3 space-y-1 text-xs">
            <div className="flex items-baseline justify-between gap-2 text-white/70">
              <span>
                <span className="text-emerald-400">✓</span> {single.name}
                {racers > 1 && <span className="text-white/40"> × {racers}</span>}
              </span>
              <span className="text-white/60">${(single.price * racers).toFixed(2)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-2 text-white/70">
              <span>
                <span className="text-emerald-400">✓</span> Racing License
                {racers > 1 && <span className="text-white/40"> × {racers}</span>}
              </span>
              <span className="text-white/60">${(licensePerRacer * racers).toFixed(2)}</span>
            </div>
            <div className="mt-1 flex items-baseline justify-between gap-2 border-t border-white/10 pt-1.5">
              <span className="text-[11px] font-bold tracking-wider text-white/80 uppercase">
                Total
              </span>
              <span className="font-bold text-white">${groupTotal.toFixed(2)}</span>
            </div>
          </div>
        )}

        {!showNewBreakdown && product.packType !== "combo" && racers > 1 && product.price > 0 && (
          <div className="mt-2 text-xs text-white/50">
            ${product.price.toFixed(2)} × {racers} racers = ${(product.price * racers).toFixed(2)}{" "}
            total
          </div>
        )}
        {product.packType === "combo" && (
          <div className="mt-2 text-xs text-white/50">
            ${(product.price / (product.raceCount ?? 1)).toFixed(2)}/race · {product.raceCount}{" "}
            heats on one bill
          </div>
        )}
      </button>
    );
  }

  // ── Single | 3-Pack columns (Option C).
  const perRace = pack.price / (pack.raceCount ?? 1);
  const saveDollars = Math.round(single.price * (pack.raceCount ?? 1) - pack.price);
  const col = (on: boolean) =>
    `rounded-lg border p-3 text-left transition-all duration-150 ${
      on
        ? "border-[#00E2E5]/70 bg-[#00E2E5]/5"
        : "border-white/10 bg-white/[0.03] hover:border-white/30"
    }`;

  return (
    <div className={cardShell} style={accentStyle}>
      {selectedFlag}
      <span className="text-[15px] font-bold text-white">{single.name}</span>
      <p className="mt-1 text-[13px] leading-relaxed text-white/50">{TIER_DESCRIPTIONS[tier]}</p>
      <TrackLine product={single} />
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button type="button" onClick={() => onSelect(single)} className={col(singleSelected)}>
          <div className="text-[10px] font-extrabold tracking-[0.14em] text-white/40 uppercase">
            Single race
          </div>
          <div className="mt-1 text-base font-extrabold text-white tabular-nums">
            ${single.price.toFixed(2)}{" "}
            <span className="text-xs font-medium text-white/40">/ racer</span>
          </div>
          <div className="mt-0.5 text-xs text-white/50">
            {racers > 1
              ? `$${single.price.toFixed(2)} × ${racers} racers = $${(single.price * racers).toFixed(2)} total`
              : "One heat — you can add more races later"}
          </div>
        </button>
        <button type="button" onClick={() => onSelect(pack)} className={col(packSelected)}>
          <div className="text-[10px] font-extrabold tracking-[0.14em] text-white/40 uppercase">
            {pack.raceCount}-Race Pack
            {saveDollars >= 1 && <span className="ml-1.5 text-amber-400">Save ${saveDollars}</span>}
          </div>
          <div className="mt-1 text-base font-extrabold text-white tabular-nums">
            ${pack.price.toFixed(2)}
          </div>
          <div className="mt-0.5 text-xs text-white/50">
            ${perRace.toFixed(2)}/race · {pack.raceCount} heats on one bill
          </div>
        </button>
      </div>
    </div>
  );
}

function hasCategory(session: { party: { category?: Category }[] }, category: Category): boolean {
  return session.party.some((m) => (m.category ?? "adult") === category);
}

export const RaceProductStepAdult: StepDef<RaceItem> = {
  id: "race-product-adult",
  title: "Adult Race",
  Component: makeProductStepComponent("adult"),
  isVisible: (_item, session) => hasCategory(session, "adult"),
  canAdvance: (item, session) => {
    if (!hasCategory(session, "adult")) return true;
    if (item.packageId) return true;
    if (item.productIdAdult) return true;
    // Already added races via "Add another" (which clears the product)? Continue.
    const adultIds = new Set(
      session.party.filter((m) => (m.category ?? "adult") === "adult").map((m) => m.id),
    );
    if (item.heats.some((h) => h.heatId && h.assignedTo && adultIds.has(h.assignedTo))) return true;
    return { reason: "Pick an adult race to continue." };
  },
};

export const RaceProductStepJunior: StepDef<RaceItem> = {
  id: "race-product-junior",
  title: "Junior Race",
  Component: makeProductStepComponent("junior"),
  isVisible: (_item, session) => hasCategory(session, "junior"),
  canAdvance: (item, session) => {
    if (!hasCategory(session, "junior")) return true;
    if (item.packageId) return true;
    if (item.productIdJunior) return true;
    // Already added races via "Add another" (which clears the product)? Continue.
    const juniorIds = new Set(
      session.party.filter((m) => m.category === "junior").map((m) => m.id),
    );
    if (item.heats.some((h) => h.heatId && h.assignedTo && juniorIds.has(h.assignedTo)))
      return true;
    return { reason: "Pick a junior race to continue." };
  },
};
