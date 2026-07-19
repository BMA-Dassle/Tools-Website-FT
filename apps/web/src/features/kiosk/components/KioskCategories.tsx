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
  landingOfferingsFor,
  type ActivityOffering,
  type BookingSession,
  type Brand,
  type CenterCode,
} from "~/features/booking";
import { enabledCombos, type ComboSpecial } from "~/features/combos";
import { packageFamilyFromPrice } from "~/features/booking/service/packages";
import { KIOSK_LOGOS, KIOSK_PHOTOS } from "../assets";
import { AdminTapZone } from "./AdminTapZone";
import { useKioskConfig } from "../KioskConfigContext";
import { gameZoneCapability } from "../config";

type CategoryKey = "exp" | "attr";

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
  onPickOffering: (offering: ActivityOffering) => void;
  onPickCombo: (combo: ComboSpecial) => void;
  /** Launch racing with a package FAMILY preselected (Experiences package tile). */
  onPickPackageExperience: (family: string) => void;
  onOpenCart: () => void;
  onOpenGameZone: () => void;
}

export function KioskCategories({
  brand,
  center,
  session,
  vipComboAvailable = true,
  uqAvailable = true,
  onPickOffering,
  onPickCombo,
  onPickPackageExperience,
  onOpenGameZone,
}: KioskCategoriesProps) {
  const [cat, setCat] = useState<CategoryKey | null>(null);
  const { config } = useKioskConfig();
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
  // (The old "Your visit so far" strip is gone — KioskFlow's chrome now shows
  // the persistent signed-in + cart session banner on every screen instead.)

  if (cat === null) {
    return (
      <div className="relative flex h-full flex-col px-[64px] pb-[28px] pt-[72px]">
        {/* Hidden staff entry: 5 taps in the header area → admin. */}
        <AdminTapZone />
        <h1 className="k-display mb-[32px] text-[82px]">
          {hasCart ? "Add anything else?" : "What are we doing today?"}
        </h1>
        <div className="flex min-h-0 flex-1 flex-col gap-[28px]">
          <CategoryCard
            photo={KIOSK_PHOTOS.vip}
            eyebrow={combos.map((c) => c.name).join(" · ") || "Bundled experiences"}
            accent="#e8b14c"
            title="Experiences"
            blurb="Multiple attractions combined into one easy price"
            onClick={() => setCat("exp")}
          />
          <CategoryCard
            photo={KIOSK_PHOTOS.race}
            eyebrow={`${offerings.length} attractions`}
            accent="#00e2e5"
            title="Attractions"
            blurb="Racing, bowling, blasters & more — pick a time and go"
            onClick={() => setCat("attr")}
          />
          {gameZone === "none" ? (
            <GameZoneUnavailableCard />
          ) : (
            <CategoryCard
              photo={KIOSK_PHOTOS.arcade}
              eyebrow={
                gameZone === "reload" ? "Reload arcade tokens" : "Reload · buy · 1 to 10 cards"
              }
              accent="#f800c6"
              title="Game Zone"
              blurb={
                gameZone === "reload"
                  ? "Reload your arcade card — no waiting"
                  : "Buy or reload arcade tokens — no waiting"
              }
              onClick={onOpenGameZone}
            />
          )}
        </div>
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
        ‹ All categories
      </button>
      <h1 className="k-display mb-[28px] text-[74px]">
        {cat === "exp" ? "Pick your experience" : "Pick an attraction"}
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
                    photo={combo.heroImage || KIOSK_PHOTOS.vip}
                    eyebrow="Most popular"
                    accent="#e8b14c"
                    title={combo.name}
                    // Tile = concise teaser (the full description lives on the
                    // overview screen this opens). The prose shortDescription was
                    // too long for the tile and overran it (owner 2026-07-18) — use
                    // the "what you get" list, which is short + scannable.
                    blurb={combo.includes.slice(0, 3).join(" · ")}
                    // Both day-tier prices, matching the overview screen's format
                    // (owner 2026-07-19: show Mon–Thu AND Fri–Sun, not "From $X").
                    priceLine={`$${(combo.price.weekday / 100).toFixed(0)}/person Mon–Thu · $${(combo.price.weekend / 100).toFixed(0)}/person Fri–Sun`}
                    disabled={locked}
                    disabledNote="Not available right now — please check back or ask an attendant."
                    onClick={() => onPickCombo(combo)}
                  />
                );
              })}
              {showQualifier && (
                <ShelfBanner
                  photo={KIOSK_PHOTOS.race}
                  eyebrow="Premium racing"
                  accent="#e53935"
                  title="Ultimate Qualifier"
                  blurb="Qualify on a Starter, then level up — POV video, free appetizer & license included."
                  // "From" stays here (unlike the flat-priced combo) because the
                  // junior variant sets the floor and adults pay more.
                  priceLine={
                    [
                      qualifierFromWeekday != null
                        ? `From $${qualifierFromWeekday.toFixed(0)}/person Mon–Thu`
                        : null,
                      qualifierFromWeekend != null
                        ? `From $${qualifierFromWeekend.toFixed(0)}/person Fri–Sun`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || undefined
                  }
                  disabled={!uqAvailable}
                  disabledNote="Not enough time left today to fit both races — please check back or ask an attendant."
                  onClick={() => onPickPackageExperience("ultimate-qualifier")}
                />
              )}
              {combos.length === 0 && !showQualifier && (
                <EmptyShelf note="No bundled experiences are running at this location today." />
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
                  wide={brand === "fasttrax" && o.slug === "race"}
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
  return (
    <div
      className="k-ph relative min-h-0 flex-1 overflow-hidden rounded-[28px] border border-white/10"
      style={
        {
          ["--k-img"]: `url(${KIOSK_PHOTOS.arcade})`,
          filter: "grayscale(0.5) brightness(0.5)",
        } as React.CSSProperties
      }
      aria-label="Game Zone cards not available on this kiosk"
    >
      <div className="absolute inset-0 flex flex-col items-center justify-center px-[64px] text-center">
        <div className="k-eyebrow mb-[12px] text-[24px] text-white/50">Game Zone</div>
        <div className="k-display text-[48px] leading-[1.15] text-white/90">
          Game Zone cards not available on this kiosk
        </div>
        <div className="mt-[16px] text-[26px] leading-[1.4] text-white/55">
          Please use another kiosk or see Guest Services
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-[8px] bg-white/20" />
    </div>
  );
}

function CategoryCard({
  photo,
  eyebrow,
  accent,
  title,
  blurb,
  onClick,
}: {
  photo: string;
  eyebrow: string;
  accent: string;
  title: string;
  blurb: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={title}
      className="k-ph k-tap relative min-h-0 flex-1 overflow-hidden rounded-[28px] border border-white/10 text-left"
      style={{ ["--k-img"]: `url(${photo})` } as React.CSSProperties}
    >
      <div className="absolute bottom-[40px] left-[48px] right-[120px]">
        <div className="k-eyebrow" style={{ color: accent }}>
          {eyebrow}
        </div>
        <div className="k-display mt-[8px] text-[74px]">{title}</div>
        <div className="mt-[10px] text-[28px] text-white/65">{blurb}</div>
      </div>
      <span
        className="k-display absolute bottom-[44px] right-[48px] text-[56px]"
        style={{ color: accent }}
      >
        ›
      </span>
      <div className="absolute inset-x-0 bottom-0 h-[8px]" style={{ background: accent }} />
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
  disabled?: boolean;
  disabledNote?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-label={title}
      className={`k-ph k-tap relative h-[340px] overflow-hidden rounded-[28px] border border-white/10 text-left ${
        disabled ? "opacity-50" : ""
      }`}
      style={{ ["--k-img"]: `url(${photo})` } as React.CSSProperties}
    >
      <div className="absolute inset-y-0 left-[48px] right-[128px] flex flex-col justify-center">
        <div className="k-eyebrow" style={{ color: disabled ? "#9aa4b2" : accent }}>
          {disabled ? "Unavailable" : eyebrow}
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
  onClick,
}: {
  offering: ActivityOffering;
  /** Kiosk's own brand — resolves shuffly's "auto" venue (both buildings have
   *  a Shuffly; this kiosk books its own side). */
  brand: Brand;
  wide?: boolean;
  onClick: () => void;
}) {
  const accent = offering.accentColor ?? "#00e2e5";
  // Which building the guest walks to — same venue badge the web landing puts
  // on every attraction card (owner 2026-07-19).
  const venue = effectiveBrand(offering, brand);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={offering.displayName}
      className={`k-ph k-tap relative overflow-hidden rounded-[28px] border border-white/10 text-left ${wide ? "col-span-2 h-[300px]" : "h-[340px]"}`}
      style={
        offering.heroImage
          ? ({ ["--k-img"]: `url(${offering.heroImage})` } as React.CSSProperties)
          : undefined
      }
    >
      {/* Venue chip — which building this attraction lives in. */}
      <div className="k-glass absolute right-[20px] top-[20px] flex items-center px-[20px] py-[12px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={KIOSK_LOGOS[venue]}
          alt={venue === "fasttrax" ? "At FastTrax" : "At HeadPinz"}
          className="h-[30px] w-auto"
        />
      </div>
      {/* FIXED text geometry (owner 2026-07-18: wrap broke + lines didn't align
          across boxes): the title zone is always 2 lines tall (1-line titles sit
          at its bottom) and the blurb zone always 2 lines, so every card's text
          lands at identical heights. textWrap:normal overrides k-display's
          text-wrap:balance — balance + clamping is a Chromium wrap-breaker. */}
      <div className="absolute inset-x-[36px] bottom-[36px]">
        <div className="flex h-[84px] items-end">
          <span
            className="k-display line-clamp-2 break-words text-[36px] leading-[1.15]"
            style={{ textWrap: "normal" }}
          >
            {offering.displayName}
          </span>
        </div>
        <div className="mt-[8px] line-clamp-2 h-[64px] break-words text-[24px] leading-[1.3] text-white/65">
          {offering.blurb}
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-[8px]" style={{ background: accent }} />
    </button>
  );
}
