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
import { useKioskConfig } from "../KioskConfigContext";
import { gameZoneCapability } from "../config";
import { useT, LanguageSwitcher, type Translate } from "../i18n";

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
  onPickOffering: (offering: ActivityOffering) => void;
  onPickCombo: (combo: ComboSpecial) => void;
  /** Launch racing with a package FAMILY preselected (Experiences package tile). */
  onPickPackageExperience: (family: string) => void;
  onOpenCart: () => void;
  onOpenGameZone: () => void;
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
}

export function KioskCategories({
  brand,
  center,
  session,
  vipComboAvailable = true,
  uqAvailable = true,
  offeringAvailable = () => true,
  offeringFirstOpen = () => undefined,
  onPickOffering,
  onPickCombo,
  onPickPackageExperience,
  onOpenGameZone,
  onOpenCodeEntry,
  appliedPromo,
  onClearPromo,
  appliedVouchers = [],
  onOpenVoucherSheet,
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
  const hasCart = session.items.length > 0;
  // Whether ANYTHING on the Experiences shelf is bookable right now. If every
  // tile inside is locked (VIP combo + Ultimate Qualifier both out of runway)
  // or the shelf is empty, the landing card itself locks — no tapping into a
  // screen of all-unavailable tiles (owner 2026-07-19).
  const anyExperienceAvailable =
    combos.some((c) => c.id !== "race-bowl" || vipComboAvailable) || (showQualifier && uqAvailable);
  // The availability key for a tile: shuffly is per BUILDING (FT vs HP side,
  // separate BMI products), so it keys by the side this kiosk's brand books.
  const offeringKey = (o: ActivityOffering) =>
    o.slug === "shuffly" ? `shuffly-${effectiveBrand(o, brand)}` : o.slug;
  // Same all-locked rule the Experiences card follows: when every attraction
  // tile inside is out of runway for the day, lock the landing card itself.
  const anyAttractionAvailable = offerings.some((o) => offeringAvailable(offeringKey(o)));
  // (The old "Your visit so far" strip is gone — KioskFlow's chrome now shows
  // the persistent signed-in + cart session banner on every screen instead.)

  if (cat === null) {
    return (
      <div className="relative flex h-full flex-col px-[64px] pb-[28px] pt-[72px]">
        {/* Language switcher — "What are we doing today?" chooser only, pinned up
            top-right ABOVE the tiles (owner 2026-07-26); hidden on the
            pick-experience / pick-attraction sub-views. */}
        <LanguageSwitcher posClass="right-[40px] top-[36px]" />
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
            disabledNote={t("categories.disabled.experience")}
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
            disabledNote={t("categories.disabled.attraction")}
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
        {/* Coupon / voucher strip (kioskPromoEnabled) — the chip becomes the
            gold applied-code banner once a code lands. Entry point mirrors the
            website's attraction-selector promo form (owner 2026-07-27). */}
        {(onOpenCodeEntry || appliedPromo || appliedVouchers.length > 0) && (
          <div className="mt-[24px] flex min-h-[84px] flex-wrap items-center justify-center gap-[18px]">
            <KioskVoucherSummary
              vouchers={appliedVouchers}
              onOpen={() => onOpenVoucherSheet?.()}
              variant="kiosk"
            />
            {appliedPromo ? (
              <div className="flex h-[84px] items-center gap-[18px] rounded-full border-[1.5px] border-[rgba(232,177,76,0.65)] bg-[rgba(232,177,76,0.10)] px-[34px]">
                <TicketGlyph color="#e8b14c" />
                <span className="k-display text-[28px] text-[#e8b14c]">{appliedPromo.code}</span>
                <span className="text-[26px] text-white/75">{promoDealLine(t, appliedPromo)}</span>
                {onClearPromo && (
                  <button
                    type="button"
                    onClick={onClearPromo}
                    aria-label={t("promo.banner.clear")}
                    className="k-tap ml-[6px] px-[8px] text-[30px] leading-none text-white/45"
                  >
                    ✕
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={onOpenCodeEntry}
                className="k-tap flex h-[84px] shrink-0 items-center gap-[16px] whitespace-nowrap rounded-full border-[1.5px] border-[rgba(0,226,229,0.5)] px-[36px] font-[family-name:var(--font-heading)] text-[26px] font-bold uppercase tracking-[0.08em] text-[#00e2e5]"
              >
                <TicketGlyph color="#00e2e5" />
                {t("promo.chip")}
              </button>
            )}
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
                // The VIP combo locks out when today has no feasible race →
                // VIP-lane → race itinerary (polled every 5 min).
                const locked = combo.id === "race-bowl" && !vipComboAvailable;
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
                    firstOpen={locked ? undefined : offeringFirstOpen(combo.id)}
                    disabled={locked}
                    disabledNote={t("categories.disabled.experience")}
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
                  disabledNote={t("categories.qualifier.disabled")}
                  onClick={() => onPickPackageExperience("ultimate-qualifier")}
                />
              )}
              {combos.length === 0 && !showQualifier && (
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
                  disabledNote={t("categories.disabled.attraction")}
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
  const t = useT();
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
      aria-label={offering.displayName}
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
            {offering.displayName}
          </span>
        </div>
        <div className="mt-[8px] line-clamp-2 h-[64px] break-words text-[24px] leading-[1.3] text-white/65">
          {disabled && disabledNote ? disabledNote : offering.blurb}
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
