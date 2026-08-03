"use client";

/**
 * Kiosk landing after the attract screen: category-first navigation
 * (owner decision 2026-07-17). Three category cards — Experiences /
 * Attractions / Game Zone — then a scoped shelf; guests never see one
 * giant list. Anything already in the cart shows as an itinerary strip
 * so multi-activity stacking is one tap per item.
 *
 * Authored to the fixed 1080×1920 kiosk canvas (px, not rem) so it fills the
 * portrait screen with the Podium photo + glass look — matches the approved
 * prototype's S.cats screen.
 *
 * Catalog sources are the SAME ones the website uses (activities-catalog +
 * combo registry): anything enabled online is automatically on the kiosk.
 */
import { useState } from "react";
import { IconFlag, IconSignature, IconUserCheck } from "@tabler/icons-react";
import {
  effectiveBrand,
  isOfferingInPromoScope,
  landingOfferingsFor,
  type ActivityOffering,
  type BookingSession,
  type Brand,
  type CenterCode,
} from "~/features/booking";
import type { AppliedPromo } from "~/features/discount-codes";
import type { AppliedVoucherState } from "~/features/booking/state/types";
import { KioskVoucherSummary } from "./KioskVoucherSheet";
import { enabledCombos, type ComboSpecial } from "~/features/combos";
import { packageFamilyFromPrice } from "~/features/booking/service/packages";
import { KIOSK_LOGOS, KIOSK_PHOTOS, kioskImg } from "../assets";
import { useResilientImage } from "../hooks/useResilientImage";
import { slotLabel, type FirstOpen } from "../service/first-available";
import { AdminTapZone } from "./AdminTapZone";
import { UTIL_TILE_BORDER_ALPHA, UTIL_TILE_CLASS, UtilityTile } from "./UtilityTile";
import { useKioskConfig } from "../KioskConfigContext";
import { gameZoneCapability } from "../config";
import { useT, useLocale, LanguageSwitcher, type Translate } from "../i18n";
import { kioskRacePacksEnabled } from "~/features/booking/service/race-pack-kiosk";

type CategoryKey = "exp" | "attr";

/** The countable noun a tile's availability count reads as, keyed per SLUG →
 *  the plural message key that renders it. Only BMI-vendored attractions (which
 *  return a per-slot count) are here — shuffly reads as tables. Everything on
 *  QAMF (bowling, KBF, and duckpin post-migration) has no lane count and shows a
 *  time-only line instead (see TIME_ONLY_SLUGS). */
const AVAILABILITY_NOUN: Record<string, "table" | "player"> = {
  shuffly: "table",
  "gel-blaster": "player",
  "laser-tag": "player",
  // Racing is intentionally omitted — no availability line on the racing tile
  // (the home-page race grid covers heat times; owner 2026-07-25).
};

/** Slugs whose vendor (QAMF/Conqueror) returns bookable times but no lane count
 *  — the tile shows "Next lane · TIME" instead of "N lanes · TIME". Duckpin is
 *  here because it migrated off BMI to QAMF (FastTrax center 11542). */
const TIME_ONLY_SLUGS = new Set(["bowling", "kbf", "duck-pin"]);

/** Experiences shelf line: "Next available · 6:15 PM · 5 slots" for the VIP
 *  combo / Ultimate Qualifier (earliest feasible start + seats). Null = no
 *  signal → the banner just omits the line. Localized via ICU plural. */
function experienceLine(t: Translate, firstOpen?: FirstOpen): string | null {
  if (!firstOpen) return null;
  const time = slotLabel(firstOpen.start);
  if (firstOpen.freeSpots == null) return t("categories.exp.nextAvailable", { time });
  return t("categories.exp.nextAvailableSlots", { time, count: firstOpen.freeSpots });
}

/** The tile availability line: "3 tables · 9:30 PM" when the vendor gives a
 *  count, "Next lane · 12:00 PM" for bowling/KBF (time only), or null when we
 *  have no signal (vendor blip → the tile just omits the line). Localized via
 *  ICU plural. */
function availabilityLine(t: Translate, slug: string, firstOpen?: FirstOpen): string | null {
  if (!firstOpen) return null;
  const time = slotLabel(firstOpen.start);
  if (TIME_ONLY_SLUGS.has(slug)) return t("categories.tile.nextLane", { time });
  const noun = AVAILABILITY_NOUN[slug];
  if (!noun || firstOpen.freeSpots == null) return null;
  const key = noun === "table" ? "categories.tile.countTables" : "categories.tile.countPlayers";
  return t(key, { count: firstOpen.freeSpots, time });
}

export interface KioskCategoriesProps {
  brand: Brand;
  center: CenterCode;
  session: BookingSession;
  /** False locks the VIP combo tile — no full race → VIP-lane → race itinerary
   *  fits today. Defaults available. */
  vipComboAvailable?: boolean;
  /** False locks the Ultimate Qualifier tile — no Starter+Intermediate pair fits
   *  today. Defaults available. */
  uqAvailable?: boolean;
  /** Per-tile bookable-today predicate from the centralized check
   *  (/api/kiosk/availability): every attraction tile locks individually as
   *  its last slot of the day passes (owner 2026-07-19). Keys are offering
   *  slugs, except shuffly which keys per building (shuffly-fasttrax /
   *  shuffly-headpinz). Defaults available. */
  offeringAvailable?: (id: string) => boolean;
  /** The soonest bookable slot per tile (same keys as offeringAvailable),
   *  rendered as the tile's "3 lanes · 9:30 PM" line. Undefined = no line. */
  offeringFirstOpen?: (id: string) => FirstOpen | undefined;
  /** True when a tile is off sale because its VENDOR is down (maintenance mode),
   *  not because the day ran out. Same keys as offeringAvailable, plus
   *  "race-pack" for the Experiences-shelf pack banner. It changes only the
   *  SENTENCE — the lock itself already comes through offeringAvailable — because
   *  "nothing left today, the front desk can help with walk-ins" is the wrong
   *  thing to tell a guest whose problem is our vendor. Defaults none. */
  offeringVendorPaused?: (id: string) => boolean;
  onPickOffering: (offering: ActivityOffering) => void;
  onPickCombo: (combo: ComboSpecial) => void;
  /** Launch racing with a package FAMILY preselected (Experiences package tile). */
  onPickPackageExperience: (family: string) => void;
  onOpenCart: () => void;
  onOpenGameZone: () => void;
  /** Open the standalone race-pack purchase flow. Race packs live on the
   *  Experiences shelf (owner 2026-07-28) beside the VIP combo and the Ultimate
   *  Qualifier; omitted = the product is not offered on this kiosk. */
  onOpenRacePacks?: () => void;
  /** "Not booking" side doors, moved off the attract screen (owner 2026-07-28).
   *  Undefined = that door is not offered here; the CALLER owns the flag and
   *  venue gating so this component stays presentational. */
  onOpenCheckin?: () => void;
  onOpenRaceGrid?: () => void;
  onOpenWaiver?: () => void;
  /** Coupon/voucher entry (kioskPromoEnabled) — undefined hides the chip. */
  onOpenCodeEntry?: () => void;
  /** The session's applied code — renders the gold banner + per-tile
   *  "Code applies" badges (same isOfferingInPromoScope the web landing uses). */
  appliedPromo?: AppliedPromo | null;
  onClearPromo?: () => void;
  /** The session's vouchers (voucherRedeem live) — the summary chip (twin of
   *  the coupon chip) opens the voucher sheet for details/removal. */
  appliedVouchers?: AppliedVoucherState[];
  onOpenVoucherSheet?: () => void;
  /** Voucher game cards scanned but NOT dispensed yet — a loud tile back to
   *  the coupon receipt, so backing out never strands the guest's cards. */
  pendingGzCardCount?: number;
}

export function KioskCategories({
  brand,
  center,
  session,
  vipComboAvailable = true,
  uqAvailable = true,
  offeringAvailable = () => true,
  offeringFirstOpen = () => undefined,
  offeringVendorPaused = () => false,
  onPickOffering,
  onPickCombo,
  onPickPackageExperience,
  onOpenGameZone,
  onOpenRacePacks,
  onOpenCheckin,
  onOpenRaceGrid,
  onOpenWaiver,
  onOpenCodeEntry,
  appliedPromo,
  onClearPromo,
  appliedVouchers = [],
  onOpenVoucherSheet,
  pendingGzCardCount = 0,
}: KioskCategoriesProps) {
  const [cat, setCat] = useState<CategoryKey | null>(null);
  const { config } = useKioskConfig();
  const t = useT();
  const gameZone = gameZoneCapability(config); // "full" | "reload" | "none"
  const offerings = landingOfferingsFor(brand, center);
  const combos = enabledCombos().filter((c) => c.center === center);
  // The Ultimate Qualifier is a premium FastTrax racing PACKAGE (not a combo);
  // surface it in Experiences wherever racing is offered.
  const showQualifier = offerings.some((o) => o.kind === "race");
  // Per-day-tier "From $X/person" teasers = lowest enabled Ultimate Qualifier
  // variant for each tier (junior variants price the floor). Mega Tuesday is a
  // Mon–Thu day. Same computed prices the picker/checkout use — display only.
  const qualifierFromWeekday = packageFamilyFromPrice("ultimate-qualifier", ["weekday", "mega"]);
  const qualifierFromWeekend = packageFamilyFromPrice("ultimate-qualifier", ["weekend"]);
  // Race packs sell at BOTH Fort Myers venues (owner 2026-07-28) — FastTrax and
  // HeadPinz FM share the campus and guests walk between them, so a pack is
  // worth offering on either bank. Gated on `showQualifier` (does this kiosk
  // offer racing at all) rather than on brand: that is the same condition, and
  // it keeps Naples — which has no karting — out without naming venues. Behind
  // the race-pack kill switch either way.
  //
  // It also has to feed the Experiences shelf's "is anything in here?" check
  // below: a card that opens onto an empty shelf is the exact failure those
  // checks exist to prevent.
  // FASTTRAX ONLY — must match KioskRacePackFlow's own guard exactly.
  //
  // 1.10.5 widened this to "any kiosk that offers racing", which put the banner
  // on HeadPinz FM (owner asked for it) — but KioskRacePackFlow still returns
  // null for a non-FastTrax brand, so tapping it opened a BLANK SCREEN.
  //
  // Selling packs from the HeadPinz bank is not a display change: the flow hands
  // `brand` to KioskPartyManager as `brandLocation`, which drives
  // pandoraFetchWaiverTemplate / pandoraCheckWaiver — i.e. WHICH WAIVER the
  // guest signs. A racing product sold at a HeadPinz kiosk needs an explicit
  // decision on that, plus a live card-present smoke, so it is not something to
  // infer here. Reverted until that call is made.
  const showRacePacks = !!onOpenRacePacks && kioskRacePacksEnabled() && brand === "fasttrax";
  // Every box in the bottom grid, in render order. Built as a list so the grid
  // can span an odd last tile across both columns instead of leaving a hole —
  // and so the two "hide once a voucher is scanned" rules are one place, not
  // scattered through JSX. The caller owns flag/venue gating: a callback only
  // arrives when that door applies at all.
  const hasVoucher = appliedVouchers.length > 0;
  const utilTiles: { key: string; node: React.ReactNode }[] = [];
  if (onOpenCheckin) {
    utilTiles.push({
      key: "checkin",
      node: (
        <UtilityTile
          icon={<IconUserCheck size={28} aria-hidden="true" />}
          label={t("attract.raceReservation")}
          color="#00e2e5"
          onClick={onOpenCheckin}
        />
      ),
    });
  }
  if (onOpenRaceGrid) {
    utilTiles.push({
      key: "racegrid",
      node: (
        <UtilityTile
          icon={<IconFlag size={28} aria-hidden="true" />}
          label={t("attract.raceGrid")}
          color="#ff6b6b"
          onClick={onOpenRaceGrid}
        />
      ),
    });
  }
  // Waiver: hidden once a voucher is scanned. LAYOUT ONLY — see the grid comment.
  if (onOpenWaiver && !hasVoucher) {
    utilTiles.push({
      key: "waiver",
      node: (
        <UtilityTile
          icon={<IconSignature size={28} aria-hidden="true" />}
          label={t("attract.waiver")}
          color="#f5ecee"
          onClick={onOpenWaiver}
        />
      ),
    });
  }
  // Undispensed voucher game cards — the one guaranteed way BACK to "Get my
  // cards" after any back-out (opens the coupon receipt, which restores from
  // the same flow-owned list). Its OWN tile, ahead of the voucher/promo chips
  // and exempt from their replace-each-other rules: cards someone is owed
  // must never be hidden by a summary chip.
  if (pendingGzCardCount > 0 && onOpenCodeEntry) {
    utilTiles.push({
      key: "gzcards",
      node: (
        <UtilityTile
          icon={<TicketGlyph color="#f800c6" />}
          label={t("codeEntry.pendingCards.chip", { n: pendingGzCardCount })}
          color="#f800c6"
          onClick={onOpenCodeEntry}
        />
      ),
    });
  }
  if (hasVoucher) {
    // The voucher summary REPLACES the code tile: it opens the sheet, and the
    // sheet is where more codes get added.
    utilTiles.push({
      key: "vouchers",
      node: (
        <KioskVoucherSummary
          vouchers={appliedVouchers}
          onOpen={() => onOpenVoucherSheet?.()}
          variant="kiosk"
        />
      ),
    });
  } else if (appliedPromo) {
    utilTiles.push({
      key: "promo",
      node: (
        <div
          className={UTIL_TILE_CLASS}
          style={{ borderColor: `#e8b14c${UTIL_TILE_BORDER_ALPHA}`, color: "#e8b14c" }}
        >
          {/* The label area is a DOOR back into the code screen — with a
              promo applied this chip used to be display-only, leaving no way
              to scan a voucher afterwards (owner 2026-07-30 audit). */}
          <button
            type="button"
            onClick={onOpenCodeEntry}
            disabled={!onOpenCodeEntry}
            className="flex min-w-0 flex-1 items-center gap-[12px] text-left"
          >
            <TicketGlyph color="#e8b14c" />
            <span className="min-w-0 truncate">{appliedPromo.code}</span>
          </button>
          {onClearPromo && (
            <button
              type="button"
              onClick={onClearPromo}
              aria-label={t("promo.banner.clear")}
              className="k-tap shrink-0 px-[6px] text-[28px] leading-none text-white/45"
            >
              ✕
            </button>
          )}
        </div>
      ),
    });
  } else if (onOpenCodeEntry) {
    utilTiles.push({
      key: "code",
      node: (
        <UtilityTile
          icon={<TicketGlyph color="#00e2e5" />}
          label={t("promo.chip")}
          color="#00e2e5"
          onClick={onOpenCodeEntry}
        />
      ),
    });
  }
  utilTiles.push({ key: "lang", node: <LanguageSwitcher inline /> });
  const hasCart = session.items.length > 0;
  // Whether ANYTHING on the Experiences shelf is bookable right now. If every
  // tile inside is locked (VIP combo + Ultimate Qualifier both out of runway)
  // or the shelf is empty, the landing card itself locks — no tapping into a
  // screen of all-unavailable tiles (owner 2026-07-19).
  // Any race-bowl* pack (v1 or the 7/31 V2) is THE VIP tile — same feasibility
  // poll, same lockout.
  const isVipPack = (id: string) => id.startsWith("race-bowl");
  // A combo's availability key is the WIRE key "race-bowl" for any VIP pack
  // (v1 or the 7/31 v2) — see the firstOpen lookup below for why.
  const comboAvailKey = (c: ComboSpecial) => (isVipPack(c.id) ? "race-bowl" : c.id);
  // A combo is locked when its vendor is down OR (for a VIP pack) no feasible
  // chain fits today. The VIP pack spans BOTH vendors — BMI race legs into a
  // QAMF lane — so either one dark takes it off the shelf (owner 2026-08-03:
  // "vip depends on both"); the registry encodes that, this just reads it.
  const comboLocked = (c: ComboSpecial) =>
    offeringVendorPaused(comboAvailKey(c)) || (isVipPack(c.id) && !vipComboAvailable);
  // Race packs are normally never time-gated (a pack is credit to spend later,
  // so it has no runway to run out of) — but they are SOLD through BMI, so a
  // vendor outage does lock them.
  const racePacksPaused = offeringVendorPaused("race-pack");
  const anyExperienceAvailable =
    combos.some((c) => !comboLocked(c)) ||
    (showQualifier && uqAvailable) ||
    (showRacePacks && !racePacksPaused);
  // The availability key for a tile: shuffly is per BUILDING (FT vs HP side,
  // separate BMI products), so it keys by the side this kiosk's brand books.
  const offeringKey = (o: ActivityOffering) =>
    o.slug === "shuffly" ? `shuffly-${effectiveBrand(o, brand)}` : o.slug;
  // Same all-locked rule the Experiences card follows: when every attraction
  // tile inside is out of runway for the day, lock the landing card itself.
  const anyAttractionAvailable = offerings.some((o) => offeringAvailable(offeringKey(o)));
  // Which sentence a locked tile carries. A vendor outage is not "we sold out" —
  // there is nothing the front desk can book either, so the guest is sent to
  // Guest Services rather than told to try a walk-in.
  const lockNote = (id: string, kind: "attraction" | "experience"): string => {
    if (offeringVendorPaused(id)) return t("categories.disabled.vendorOutage");
    // Literal keys, not a template — MessageKey is a union of string literals and
    // an interpolated key is not checkable against it.
    return kind === "attraction"
      ? t("categories.disabled.attraction")
      : t("categories.disabled.experience");
  };
  // A CATEGORY card takes the outage sentence only when EVERY tile behind it is
  // vendor-paused — otherwise "see Guest Services" would be printed over a shelf
  // that still has bookable lanes in it.
  const expKeys = [
    ...combos.map(comboAvailKey),
    ...(showQualifier ? ["ultimate-qualifier"] : []),
    ...(showRacePacks ? ["race-pack"] : []),
  ];
  const expAllPaused = expKeys.length > 0 && expKeys.every((k) => offeringVendorPaused(k));
  const attrAllPaused =
    offerings.length > 0 && offerings.every((o) => offeringVendorPaused(offeringKey(o)));
  // (The old "Your visit so far" strip is gone — KioskFlow's chrome now shows
  // the persistent signed-in + cart session banner on every screen instead.)

  if (cat === null) {
    return (
      <div className="relative flex h-full flex-col px-[64px] pb-[28px] pt-[72px]">
        {/* The language switcher is rendered IN FLOW, in the utility row near the
            bottom — see that row. Fixed positioning does not work here: the
            canvas is transformed (so fixed resolves against it) and .k-flow-body
            scrolls, so a fixed switcher gets clipped at the body edge and landed
            under the util bar, untappable (owner 2026-07-28). */}
        {/* Hidden staff entry: 5 taps in the header area → admin. */}
        <AdminTapZone />
        <h1 className="k-display mb-[32px] text-[82px]">
          {hasCart ? t("categories.heading.addAnything") : t("categories.heading.whatToday")}
        </h1>
        <div className="flex min-h-0 flex-1 flex-col gap-[28px]">
          {/* Naples has no karting — its category cards show lanes, not track
              photography, and the blurb sells what's actually there. */}
          <CategoryCard
            photo={center === "naples" ? KIOSK_PHOTOS.vipLanes : KIOSK_PHOTOS.vip}
            eyebrow={combos.map((c) => c.name).join(" · ") || t("categories.exp.eyebrowFallback")}
            accent="#e8b14c"
            title={t("categories.exp.title")}
            blurb={t("categories.exp.blurb")}
            disabled={!anyExperienceAvailable}
            disabledNote={
              expAllPaused
                ? t("categories.disabled.vendorOutage")
                : t("categories.disabled.experience")
            }
            onClick={() => setCat("exp")}
          />
          <CategoryCard
            photo={brand === "headpinz" ? KIOSK_PHOTOS.bowl : KIOSK_PHOTOS.race}
            eyebrow={t("categories.attr.eyebrow", { count: offerings.length })}
            accent="#00e2e5"
            title={t("categories.attr.title")}
            blurb={
              center === "naples"
                ? t("categories.attr.blurb.naples")
                : t("categories.attr.blurb.default")
            }
            disabled={!anyAttractionAvailable}
            disabledNote={
              attrAllPaused
                ? t("categories.disabled.vendorOutage")
                : t("categories.disabled.attraction")
            }
            onClick={() => setCat("attr")}
          />
          {gameZone === "none" ? (
            <GameZoneUnavailableCard />
          ) : (
            <CategoryCard
              photo={KIOSK_PHOTOS.arcade}
              eyebrow={
                gameZone === "reload"
                  ? t("categories.gameZone.eyebrow.reload")
                  : t("categories.gameZone.eyebrow.full")
              }
              accent="#f800c6"
              // Game Zone — locked glossary proper noun, never translated.
              title="Game Zone"
              blurb={
                gameZone === "reload"
                  ? t("categories.gameZone.blurb.reload")
                  : t("categories.gameZone.blurb.full")
              }
              onClick={onOpenGameZone}
            />
          )}
        </div>

        {/* No shortcut row here (owner 2026-07-28). VIP Experience is dropped —
            the Experiences card already leads to it, so it was a second door
            onto the same room. Race packs moved INTO the Experiences shelf,
            beside the VIP combo and the Ultimate Qualifier, where a guest is
            already comparing premium racing. The code/voucher strip below is
            NOT a shortcut — it carries a code into whatever the guest picks
            next — so it stays. */}
        {/* UTILITY ROWS — ONE grid, not two flex rows.

            Every box here is the same UtilityTile shape (see UtilityTile.tsx):
            same height, radius, border alpha and type, sharing a class string so
            none can drift. They used to be four hand-rolled buttons with three
            different border alphas and two radii, laid out as two separate flex
            rows whose columns could never line up — which is exactly why they
            read as unrelated controls (owner 2026-07-28).

            Fixed 2 columns, so every tile is the same width and the rows align.
            An odd last tile spans both columns rather than leaving a hole.

            Contents in order: the "not booking" side doors moved off the attract
            screen, then the code/voucher tile, then language.

            Two hide rules (owner 2026-07-28), both about handing the grid a slot
            back once a voucher is in play:
              - the WAIVER door hides. LAYOUT ONLY — a voucher is not a signed
                waiver, and /kiosk/waiver plus the in-flow waiver step are
                untouched and still reachable.
              - the "Coupon or voucher?" tile hides, because the voucher summary
                tile replaces it and the sheet it opens is where further codes
                get added. Two doors onto the same sheet is one too many. */}
        {utilTiles.length > 0 && (
          <div className="mt-[22px] grid shrink-0 grid-cols-2 gap-[18px]">
            {utilTiles.map((tile, i) => (
              <div
                key={tile.key}
                className={
                  utilTiles.length % 2 === 1 && i === utilTiles.length - 1 ? "col-span-2" : ""
                }
              >
                {tile.node}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col px-[64px] pb-[28px] pt-[72px]">
      {/* Hidden staff entry: 5 taps in the top strip (above the back button) → admin. */}
      <AdminTapZone className="absolute inset-x-0 top-0 z-20 h-[64px] w-full opacity-0" />
      <button
        type="button"
        onClick={() => setCat(null)}
        className="k-btn-ghost k-tap mb-[28px] h-[76px] self-start px-[32px] text-[24px]"
      >
        ‹ {t("categories.backToCategories")}
      </button>
      <h1 className="k-display mb-[28px] text-[74px]">
        {cat === "exp" ? t("categories.pick.experience") : t("categories.pick.attraction")}
      </h1>
      <div className="relative min-h-0 flex-1">
        <div className="kiosk-scroll h-full pb-[24px]">
          {cat === "exp" && (
            <div className="flex flex-col gap-[24px]">
              {combos.map((combo) => {
                // Locked when a vendor it needs is down, or (VIP pack) today has
                // no feasible race → VIP-lane → race itinerary (polled every 5 min).
                const locked = comboLocked(combo);
                return (
                  <ShelfBanner
                    key={combo.id}
                    photo={kioskImg(combo.heroImage) || KIOSK_PHOTOS.vip}
                    eyebrow={t("categories.eyebrow.mostPopular")}
                    accent="#e8b14c"
                    // combo.name is a product proper noun (data-driven) — never
                    // translated.
                    title={combo.name}
                    // Tile = concise teaser (the full description lives on the
                    // overview screen this opens). The prose shortDescription was
                    // too long for the tile and overran it (owner 2026-07-18) — use
                    // the "what you get" list, which is short + scannable.
                    blurb={combo.includes.slice(0, 3).join(" · ")}
                    // Both day-tier prices, matching the overview screen's format
                    // (owner 2026-07-19: show Mon–Thu AND Fri–Sun, not "From $X").
                    // The prices interpolate as pre-formatted "$65" values — only
                    // the "/person" + day-range wording localizes; the number is
                    // untouched.
                    priceLine={t("categories.combo.priceLine", {
                      weekday: `$${(combo.price.weekday / 100).toFixed(0)}`,
                      weekend: `$${(combo.price.weekend / 100).toFixed(0)}`,
                    })}
                    // The availability compute keys the VIP pack by the WIRE key
                    // "race-bowl" regardless of which pack entry is live (v1 or
                    // the 7/31 race-bowl-v2), so look it up by that key — the
                    // raw v2 id has no entry and silently dropped the line.
                    firstOpen={locked ? undefined : offeringFirstOpen(comboAvailKey(combo))}
                    disabled={locked}
                    disabledNote={lockNote(comboAvailKey(combo), "experience")}
                    onClick={() => onPickCombo(combo)}
                  />
                );
              })}
              {showQualifier && (
                <ShelfBanner
                  photo={KIOSK_PHOTOS.race}
                  eyebrow={t("categories.eyebrow.premiumRacing")}
                  accent="#e53935"
                  // "Ultimate Qualifier" is a racing PACKAGE product name — kept
                  // untranslated like the combo names above.
                  title="Ultimate Qualifier"
                  blurb={t("categories.qualifier.blurb")}
                  // "From" stays here (unlike the flat-priced combo) because the
                  // junior variant sets the floor and adults pay more. Prices
                  // interpolate as pre-formatted "$49" values.
                  priceLine={
                    [
                      qualifierFromWeekday != null
                        ? t("categories.qualifier.fromWeekday", {
                            price: `$${qualifierFromWeekday.toFixed(0)}`,
                          })
                        : null,
                      qualifierFromWeekend != null
                        ? t("categories.qualifier.fromWeekend", {
                            price: `$${qualifierFromWeekend.toFixed(0)}`,
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || undefined
                  }
                  firstOpen={uqAvailable ? offeringFirstOpen("ultimate-qualifier") : undefined}
                  disabled={!uqAvailable}
                  // Vendor outage wins the copy: "not enough time left today to
                  // fit both races" would be a lie when the truth is BMI is dark.
                  disabledNote={
                    offeringVendorPaused("ultimate-qualifier")
                      ? t("categories.disabled.vendorOutage")
                      : t("categories.qualifier.disabled")
                  }
                  onClick={() => onPickPackageExperience("ultimate-qualifier")}
                />
              )}
              {/* Standalone race packs — moved here from the attract screen
                  (owner 2026-07-28) to sit with the other premium racing
                  products a guest is already comparing, rather than as a
                  shortcut button hanging off another screen. */}
              {showRacePacks && (
                <ShelfBanner
                  photo={KIOSK_PHOTOS.raceAction}
                  eyebrow={t("categories.eyebrow.premiumRacing")}
                  accent="#e8b14c"
                  // "Race packs" is the product name, kept untranslated like the
                  // combo and Ultimate Qualifier names above it.
                  title="Race Packs"
                  blurb={t("categories.racePacks.blurb")}
                  priceLine={t("categories.racePacks.priceLine", { price: "$49.99" })}
                  // The one thing that CAN lock a pack: packs sell through BMI
                  // (booking/sell + person/register*), so a BMI outage takes them
                  // off the shelf even though they have no time window.
                  disabled={racePacksPaused}
                  disabledNote={t("categories.disabled.vendorOutage")}
                  onClick={() => onOpenRacePacks?.()}
                />
              )}
              {combos.length === 0 && !showQualifier && !showRacePacks && (
                <EmptyShelf note={t("categories.emptyShelf")} />
              )}
            </div>
          )}
          {cat === "attr" && (
            <div className="grid grid-cols-2 gap-[24px]">
              {offerings.map((o) => (
                <OfferingTile
                  key={o.slug}
                  offering={o}
                  brand={brand}
                  wide={
                    (brand === "fasttrax" && o.slug === "race") ||
                    (brand === "headpinz" && o.slug === "bowling")
                  }
                  // Last slot of the day gone → the tile locks individually
                  // instead of dead-ending the guest inside a flow with
                  // nothing to book (owner 2026-07-19).
                  disabled={!offeringAvailable(offeringKey(o))}
                  disabledNote={lockNote(offeringKey(o), "attraction")}
                  firstOpen={offeringFirstOpen(offeringKey(o))}
                  // Gold "Code applies" badge — same scope predicate the web
                  // landing badges with.
                  promoApplies={!!appliedPromo && isOfferingInPromoScope(o, appliedPromo)}
                  onClick={() => onPickOffering(o)}
                />
              ))}
            </div>
          )}
        </div>
        <div className="k-scroll-fade" />
      </div>
    </div>
  );
}

function EmptyShelf({ note }: { note: string }) {
  return (
    <div className="k-glass px-[40px] py-[64px] text-center text-[28px] text-white/55">{note}</div>
  );
}

/** Shown in the Game Zone slot when this kiosk has no card hardware (no dispenser
 *  and no MSR reader) — owner 2026-07-19. Non-interactive: guests are pointed to
 *  another kiosk or Guest Services. */
function GameZoneUnavailableCard() {
  const photoUrl = useResilientImage(KIOSK_PHOTOS.arcade);
  const t = useT();
  return (
    <div
      className="k-ph relative min-h-0 flex-1 overflow-hidden rounded-[28px] border border-white/10"
      style={
        {
          ["--k-img"]: `url(${photoUrl})`,
          filter: "grayscale(0.5) brightness(0.5)",
        } as React.CSSProperties
      }
      aria-label={t("categories.gameZone.unavailable.title")}
    >
      <div className="absolute inset-0 flex flex-col items-center justify-center px-[64px] text-center">
        {/* Game Zone — locked glossary proper noun, never translated. */}
        <div className="k-eyebrow mb-[12px] text-[24px] text-white/50">Game Zone</div>
        <div className="k-display text-[48px] leading-[1.15] text-white/90">
          {t("categories.gameZone.unavailable.title")}
        </div>
        <div className="mt-[16px] text-[26px] leading-[1.4] text-white/55">
          {t("categories.gameZone.unavailable.note")}
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-[8px] bg-white/20" />
    </div>
  );
}

/** Full-bleed photo category tile (k-ph + eyebrow + k-display title + accent
 *  bar). Exported for reuse by kiosk-native tile screens (Race Info hub). */
export function CategoryCard({
  photo,
  eyebrow,
  accent,
  title,
  blurb,
  disabled,
  disabledNote,
  onClick,
}: {
  photo: string;
  eyebrow: string;
  accent: string;
  title: string;
  blurb: string;
  /** Locks the card (same treatment as ShelfBanner): grayed, "Unavailable"
   *  eyebrow, note replaces the blurb, no chevron, tap does nothing. */
  disabled?: boolean;
  disabledNote?: string;
  onClick: () => void;
}) {
  const photoUrl = useResilientImage(photo);
  const t = useT();
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-label={title}
      className={`k-ph k-tap relative min-h-0 flex-1 overflow-hidden rounded-[28px] border border-white/10 text-left ${
        disabled ? "opacity-50" : ""
      }`}
      style={{ ["--k-img"]: `url(${photoUrl})` } as React.CSSProperties}
    >
      <div className="absolute bottom-[40px] left-[48px] right-[120px]">
        <div className="k-eyebrow" style={{ color: disabled ? "#9aa4b2" : accent }}>
          {disabled ? t("categories.tile.unavailable") : eyebrow}
        </div>
        <div className="k-display mt-[8px] text-[74px]">{title}</div>
        <div className="mt-[10px] text-[28px] text-white/65">
          {disabled && disabledNote ? disabledNote : blurb}
        </div>
      </div>
      {!disabled && (
        <span
          className="k-display absolute bottom-[44px] right-[48px] text-[56px]"
          style={{ color: accent }}
        >
          ›
        </span>
      )}
      <div
        className="absolute inset-x-0 bottom-0 h-[8px]"
        style={{ background: disabled ? "#555" : accent }}
      />
    </button>
  );
}

function ShelfBanner({
  photo,
  eyebrow,
  accent,
  title,
  blurb,
  priceLine,
  firstOpen,
  disabled,
  disabledNote,
  onClick,
}: {
  photo: string;
  eyebrow: string;
  accent: string;
  title: string;
  blurb: string;
  /** Own row under the blurb for pricing (e.g. "$65/person Mon–Thu · $75/person
   *  Fri–Sun") so day-tier prices stay scannable instead of wrapping mid-blurb.
   *  Hidden while disabled — the disabledNote replaces the sell copy. */
  priceLine?: string;
  /** Earliest feasible slot for the experiences line ("Next available · TIME ·
   *  N slots"). Undefined = no line. */
  firstOpen?: FirstOpen;
  disabled?: boolean;
  disabledNote?: string;
  onClick: () => void;
}) {
  const photoUrl = useResilientImage(photo);
  const t = useT();
  const availLine = disabled ? null : experienceLine(t, firstOpen);
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-label={title}
      className={`k-ph k-tap relative h-[340px] overflow-hidden rounded-[28px] border border-white/10 text-left ${
        disabled ? "opacity-50" : ""
      }`}
      style={{ ["--k-img"]: `url(${photoUrl})` } as React.CSSProperties}
    >
      <div className="absolute inset-y-0 left-[48px] right-[128px] flex flex-col justify-center">
        <div className="k-eyebrow" style={{ color: disabled ? "#9aa4b2" : accent }}>
          {disabled ? t("categories.tile.unavailable") : eyebrow}
        </div>
        <div className="k-display mt-[8px] text-[56px] leading-[1.05] text-balance">{title}</div>
        <div className="mt-[12px] line-clamp-3 text-[28px] leading-snug text-pretty break-words text-white/70">
          {disabled && disabledNote ? disabledNote : blurb}
        </div>
        {priceLine && !disabled && (
          <div className="mt-[12px] text-[26px] font-semibold tabular-nums text-white/85">
            {priceLine}
          </div>
        )}
        {availLine && (
          <div className="mt-[12px] flex items-center gap-[10px]">
            <span className="h-[12px] w-[12px] flex-none rounded-full bg-[#46d68c]" />
            <span className="text-[26px] font-bold uppercase tracking-[0.06em] tabular-nums text-[#46d68c]">
              {availLine}
            </span>
          </div>
        )}
      </div>
      {!disabled && (
        <span
          className="k-display absolute right-[48px] top-1/2 -translate-y-1/2 text-[52px]"
          style={{ color: accent }}
        >
          ›
        </span>
      )}
      <div
        className="absolute inset-x-0 bottom-0 h-[8px]"
        style={{ background: disabled ? "#555" : accent }}
      />
    </button>
  );
}

function OfferingTile({
  offering,
  brand,
  wide,
  disabled,
  disabledNote,
  firstOpen,
  promoApplies,
  onClick,
}: {
  offering: ActivityOffering;
  /** Kiosk's own brand — resolves shuffly's "auto" venue (both buildings have
   *  a Shuffly; this kiosk books its own side). */
  brand: Brand;
  wide?: boolean;
  /** Locks the tile with the ShelfBanner treatment; disabledNote replaces the
   *  blurb (e.g. bowling with no lanes left today). */
  disabled?: boolean;
  disabledNote?: string;
  /** Soonest bookable slot → the "3 lanes · 9:30 PM" line above the title. */
  firstOpen?: FirstOpen;
  /** The applied coupon covers this tile → gold "Code applies" badge. */
  promoApplies?: boolean;
  onClick: () => void;
}) {
  const accent = offering.accentColor ?? "#00e2e5";
  const { t, locale } = useLocale();
  // Tile name + description are DATA (activities-catalog), so they localize from
  // the offering's own `es` block rather than the message catalog — same pattern
  // as the combo marketing copy. A missing `es` field keeps the English one
  // (brand proper nouns: "Nexus Laser Tag", "Shuffle Showdown", "Kids Bowl Free").
  const name = (locale === "es" ? offering.es?.displayName : null) ?? offering.displayName;
  const blurb = (locale === "es" ? offering.es?.blurb : null) ?? offering.blurb;
  // Which building the guest walks to — same venue badge the web landing puts
  // on every attraction card (owner 2026-07-19).
  const venue = effectiveBrand(offering, brand);
  const heroUrl = useResilientImage(kioskImg(offering.heroImage));
  const logoUrl = useResilientImage(KIOSK_LOGOS[venue]);
  // Neutral "soonest opening" line (owner 2026-07-25: one calm tone, no urgency
  // colors). Hidden while locked — disabledNote carries the message instead.
  const availLine = disabled ? null : availabilityLine(t, offering.slug, firstOpen);
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-label={name}
      className={`k-ph k-tap relative overflow-hidden rounded-[28px] border border-white/10 text-left ${wide ? "col-span-2 h-[300px]" : "h-[340px]"} ${disabled ? "opacity-50" : ""}`}
      style={heroUrl ? ({ ["--k-img"]: `url(${heroUrl})` } as React.CSSProperties) : undefined}
    >
      {/* Gold coupon badge — top-left (venue chip owns top-right). */}
      {promoApplies && !disabled && (
        <div className="k-display absolute left-[20px] top-[20px] rounded-full bg-[#e8b14c] px-[22px] py-[10px] text-[22px] text-[#2a1c02] shadow-[0_10px_34px_rgba(232,177,76,0.45)]">
          {t("promo.badge")}
        </div>
      )}
      {/* Venue chip — which building this attraction lives in. */}
      <div className="k-glass absolute right-[20px] top-[20px] flex items-center px-[20px] py-[12px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logoUrl}
          alt={t("categories.tile.atVenue", {
            venue: venue === "fasttrax" ? "FastTrax" : "HeadPinz",
          })}
          className="h-[30px] w-auto"
        />
      </div>
      {/* FIXED text geometry (owner 2026-07-18: wrap broke + lines didn't align
          across boxes): the title zone is always 2 lines tall (1-line titles sit
          at its bottom) and the blurb zone always 2 lines, so every card's text
          lands at identical heights. Lifted to bottom-[64px] to clear the
          availability footer below. textWrap:normal overrides k-display's
          text-wrap:balance — balance + clamping is a Chromium wrap-breaker. */}
      <div className="absolute inset-x-[36px] bottom-[64px]">
        <div className="flex h-[84px] items-end">
          <span
            className="k-display line-clamp-2 break-words text-[36px] leading-[1.15]"
            style={{ textWrap: "normal" }}
          >
            {name}
          </span>
        </div>
        <div className="mt-[8px] line-clamp-2 h-[64px] break-words text-[24px] leading-[1.3] text-white/65">
          {disabled && disabledNote ? disabledNote : blurb}
        </div>
      </div>
      {/* Availability line sits on the accent bar as a footer (owner 2026-07-25:
          moved down from above the title, then green = available per owner —
          one green, NOT red/amber urgency tiers). Reserved 0–64px bottom zone
          keeps titles aligned whether or not a tile has a line. */}
      <div className="absolute inset-x-0 bottom-0">
        <div
          className={`flex h-[44px] items-center gap-[10px] px-[36px] ${availLine ? "bg-black/25" : ""}`}
        >
          {availLine && (
            <>
              <span className="h-[10px] w-[10px] flex-none rounded-full bg-[#46d68c]" />
              <span className="text-[22px] font-bold uppercase leading-none tracking-[0.08em] tabular-nums text-[#46d68c]">
                {availLine}
              </span>
            </>
          )}
        </div>
        <div className="h-[8px]" style={{ background: disabled ? "#555" : accent }} />
      </div>
    </button>
  );
}

/** "15% off today" / "$5.00 off today" tail for the applied-code banner. */
function promoDealLine(t: Translate, promo: AppliedPromo): string {
  if (promo.mechanic === "percent" && promo.amountPct != null) {
    return t("promo.banner.percent", { pct: promo.amountPct });
  }
  if (promo.amountCents != null) {
    return t("promo.banner.fixed", { amount: `$${(promo.amountCents / 100).toFixed(2)}` });
  }
  return "";
}

/** Ticket outline glyph (house rule: icons, never emoji). */
function TicketGlyph({ color }: { color: string }) {
  return (
    <svg
      width="34"
      height="34"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M15 5v2" />
      <path d="M15 11v2" />
      <path d="M15 17v2" />
      <path d="M5 5h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V7a2 2 0 0 1 2-2" />
    </svg>
  );
}
