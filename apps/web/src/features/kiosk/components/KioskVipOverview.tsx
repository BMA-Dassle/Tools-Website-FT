"use client";

/**
 * VIP / Experiences overview — the itinerary screen the approved prototype had
 * (S.overview) that the build was missing: instead of dropping the guest
 * straight into the race wizard, show the combo's numbered legs, per-person
 * price, and a single "Let's set it up" CTA first.
 *
 * Authored to the fixed 1080×1920 canvas. KioskFlow wraps this in its chrome
 * with the VIP photo backdrop.
 */
import type { Brand } from "~/features/booking";
import type { ComboLeg, ComboSpecial } from "~/features/combos";
import {
  comboPriceCentsForDate,
  comboMinHeadcount,
  comboStartHoursLabel,
} from "~/features/combos/combo-specials";
import { todayYmd } from "../service/first-available";
import { BrandLogo } from "./BrandLogo";
import { useT, useLocale, type Translate } from "../i18n";

function attractionLabel(slug: string, t: Translate): string {
  switch (slug) {
    case "gel-blaster":
      return t("vip.attraction.gelBlaster");
    case "laser-tag":
      return t("vip.attraction.laserTag");
    case "duck-pin":
      return t("vip.attraction.duckpin");
    case "shuffly":
      return t("vip.attraction.shuffleboard");
    default:
      return t("vip.attraction.generic");
  }
}

function legLabel(leg: ComboLeg, t: Translate): { title: string; sub: string } {
  if (leg.kind === "race") {
    // `tier` is a data value (Starter/Pro/…) and stays as returned.
    const tier = leg.tier.charAt(0).toUpperCase() + leg.tier.slice(1);
    return { title: t("vip.leg.race.title", { tier }), sub: t("vip.leg.race.sub") };
  }
  if (leg.kind === "bowling") {
    return {
      title: t(leg.vip ? "vip.leg.bowling.titleVip" : "vip.leg.bowling.title", {
        min: leg.durationMinutes,
      }),
      sub: t(leg.vip ? "vip.leg.bowling.subVip" : "vip.leg.bowling.sub"),
    };
  }
  return { title: attractionLabel(leg.slug, t), sub: t("vip.leg.attraction.sub") };
}

/** Which venue (brand) each leg happens at — racing is FastTrax, bowling +
 *  attractions are HeadPinz. Shown as a logo on the leg so guests know where to
 *  walk for each step (owner 2026-07-19). */
function legVenue(leg: ComboLeg): { brand: Brand; name: string } {
  if (leg.kind === "race") return { brand: "fasttrax", name: "FastTrax" };
  return { brand: "headpinz", name: "HeadPinz" };
}

export function KioskVipOverview({
  combo,
  available = true,
  onStart,
  onBack,
}: {
  combo: ComboSpecial;
  /** False locks the CTA — no feasible race → VIP-lane → race itinerary today. */
  available?: boolean;
  onStart: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const perPerson = comboPriceCentsForDate(combo, todayYmd());
  const minHead = comboMinHeadcount(combo);
  // Combo marketing copy is data (combo-specials.ts); in Spanish, prefer the
  // per-field `es` overrides, falling back to English per field.
  const cEs = locale === "es" ? combo.es : undefined;
  const included = cEs?.includes ?? combo.includes ?? [];
  const durationLabel = cEs?.durationLabel ?? combo.durationLabel;
  const description =
    cEs?.longDescription ??
    cEs?.shortDescription ??
    combo.longDescription ??
    combo.shortDescription;

  return (
    <>
      <div className="k-flow-head">
        <div className="k-fh-top">
          <span className="k-eyebrow" style={{ color: "#e8b14c" }}>
            {t("vip.eyebrow")}
          </span>
          {durationLabel ? (
            <span className="k-chip" style={{ height: 60, fontSize: 24 }}>
              {durationLabel}
            </span>
          ) : null}
        </div>
        <h1 className="k-display k-fh-title mt-[16px]">{combo.name}</h1>
        <div className="mt-[12px] text-[26px] font-semibold text-white/70 tabular-nums">
          {t("vip.priceLine", {
            weekday: `$${(combo.price.weekday / 100).toFixed(0)}`,
            weekend: `$${(combo.price.weekend / 100).toFixed(0)}`,
          })}
        </div>
        {/* Estimated start times (owner 2026-07-18) — registry-driven, so a
            future combo with different hours self-updates. */}
        {combo.startHours?.length ? (
          <div className="mt-[8px] text-[26px] font-semibold text-[#e8b14c] tabular-nums">
            {t("vip.startTimes", { times: comboStartHoursLabel(combo) })}
          </div>
        ) : null}
      </div>

      <div className="k-flow-body">
        <p className="mb-[28px] text-[28px] text-white/60">{description}</p>
        <p className="mb-[20px] text-[24px] text-white/45">{t("vip.stepByStep")}</p>
        <div className="relative space-y-[20px]">
          {combo.components.map((leg, i) => {
            const { title, sub } = legLabel(leg, t);
            const venue = legVenue(leg);
            return (
              <div key={i} className="flex items-stretch gap-[24px]">
                <div className="flex flex-col items-center">
                  <div className="k-display grid h-[64px] w-[64px] shrink-0 place-items-center rounded-full border-2 border-[#e8b14c] text-[30px] text-[#e8b14c]">
                    {i + 1}
                  </div>
                  {i < combo.components.length - 1 && (
                    <div className="mt-[6px] w-[3px] flex-1 rounded-full bg-gradient-to-b from-[#e8b14c]/70 to-[#00e2e5]/40" />
                  )}
                </div>
                <div className="k-glass mb-[4px] flex flex-1 items-center justify-between gap-[20px] p-[24px]">
                  <div className="min-w-0">
                    <div className="k-display text-[40px]">{title}</div>
                    <div className="mt-[6px] text-[26px] text-white/55">{sub}</div>
                  </div>
                  <div className="flex shrink-0 flex-col items-center gap-[6px]">
                    <BrandLogo
                      brand={venue.brand}
                      alt={venue.name}
                      className="h-[52px] w-[104px] object-contain"
                      fallbackClassName="k-display text-[24px] leading-none text-white/90"
                    />
                    <span className="text-[18px] uppercase tracking-widest text-white/40">
                      {t("vip.atVenue", { venue: venue.name })}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {included.length > 0 && (
          <div className="k-glass mt-[28px] p-[28px]">
            <div className="k-eyebrow mb-[16px] text-[#46d68c]">{t("vip.allIncluded")}</div>
            <div className="grid grid-cols-2 gap-x-[24px] gap-y-[12px]">
              {included.map((inc, i) => (
                <div key={i} className="flex items-start gap-[12px] text-[24px] text-white/75">
                  <span className="mt-[2px] text-[#46d68c]">✓</span>
                  <span>{inc}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Voucher inclusions — their own section (registry data with per-field
            ES fallback); the shared terms render once in the note. */}
        {combo.voucherIncludes && (
          <div
            className="mt-[20px] rounded-[20px] border-2 border-[#e8b14c]/50 bg-[#e8b14c]/[0.07] p-[28px]"
          >
            <div className="k-eyebrow mb-[16px] text-[#e8b14c]">
              {cEs?.voucherIncludes?.title ??
                combo.voucherIncludes.title ??
                "Plus vouchers to your favorite attractions"}
            </div>
            <div className="grid grid-cols-2 gap-x-[24px] gap-y-[12px]">
              {(cEs?.voucherIncludes?.items ?? combo.voucherIncludes.items).map((inc, i) => (
                <div key={i} className="flex items-start gap-[12px] text-[24px] text-white/75">
                  <span className="mt-[2px] text-[#e8b14c]">✓</span>
                  <span>{inc}</span>
                </div>
              ))}
            </div>
            <p className="mt-[16px] text-[20px] leading-snug text-white/50">
              {cEs?.voucherIncludes?.note ?? combo.voucherIncludes.note}
            </p>
          </div>
        )}

        {minHead > 1 && (
          <p className="mt-[24px] text-center text-[24px] text-[#e8b14c]/80">
            {t("vip.minGuests", { count: minHead })}
          </p>
        )}
      </div>

      <div className="k-z-actions">
        <button type="button" onClick={onBack} className="k-btn-ghost k-tap">
          {t("vip.back")}
        </button>
        <button
          type="button"
          onClick={available ? onStart : undefined}
          disabled={!available}
          className="k-btn-primary k-tap disabled:opacity-40"
        >
          {available ? (
            <>
              <span className="k-num">${(perPerson / 100).toFixed(0)}</span>
              {t("vip.perPersonSetUp")}
            </>
          ) : (
            t("vip.notAvailable")
          )}
        </button>
      </div>
    </>
  );
}
