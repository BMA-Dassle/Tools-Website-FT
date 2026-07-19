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
import type { ComboLeg, ComboSpecial } from "~/features/combos";
import {
  comboPriceCentsForDate,
  comboMinHeadcount,
  comboStartHoursLabel,
} from "~/features/combos/combo-specials";
import { todayYmd } from "../service/first-available";
import { KIOSK_LOGOS } from "../assets";

const ATTRACTION_LABEL: Record<string, string> = {
  "gel-blaster": "Gel Blaster",
  "laser-tag": "Laser Tag",
  "duck-pin": "Duckpin Bowling",
  shuffly: "Shuffleboard",
};

function legLabel(leg: ComboLeg): { title: string; sub: string } {
  if (leg.kind === "race") {
    const tier = leg.tier.charAt(0).toUpperCase() + leg.tier.slice(1);
    return { title: `${tier} Race`, sub: "Suit up, helmet on, hit the track" };
  }
  if (leg.kind === "bowling") {
    return {
      title: `${leg.durationMinutes}-Min ${leg.vip ? "VIP " : ""}Bowling`,
      sub: leg.vip ? "Your own semi-private suite" : "Lanes reserved for your group",
    };
  }
  return { title: ATTRACTION_LABEL[leg.slug] ?? "Attraction", sub: "Included in your experience" };
}

/** Which venue (brand) each leg happens at — racing is FastTrax, bowling +
 *  attractions are HeadPinz. Shown as a logo on the leg so guests know where to
 *  walk for each step (owner 2026-07-19). */
function legVenue(leg: ComboLeg): { logo: string; name: string } {
  if (leg.kind === "race") return { logo: KIOSK_LOGOS.fasttrax, name: "FastTrax" };
  return { logo: KIOSK_LOGOS.headpinz, name: "HeadPinz" };
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
  const perPerson = comboPriceCentsForDate(combo, todayYmd());
  const minHead = comboMinHeadcount(combo);
  const included = combo.includes ?? [];

  return (
    <>
      <div className="k-flow-head">
        <div className="k-fh-top">
          <span className="k-eyebrow" style={{ color: "#e8b14c" }}>
            Experience
          </span>
          {combo.durationLabel ? (
            <span className="k-chip" style={{ height: 60, fontSize: 24 }}>
              {combo.durationLabel}
            </span>
          ) : null}
        </div>
        <h1 className="k-display k-fh-title mt-[16px]">{combo.name}</h1>
        <div className="mt-[12px] text-[26px] font-semibold text-white/70 tabular-nums">
          ${(combo.price.weekday / 100).toFixed(0)}/person Mon–Thu · $
          {(combo.price.weekend / 100).toFixed(0)}/person Fri–Sun
        </div>
        {/* Estimated start times (owner 2026-07-18) — registry-driven, so a
            future combo with different hours self-updates. */}
        {combo.startHours?.length ? (
          <div className="mt-[8px] text-[26px] font-semibold text-[#e8b14c] tabular-nums">
            Estimated start times: {comboStartHoursLabel(combo)}
          </div>
        ) : null}
      </div>

      <div className="k-flow-body">
        <p className="mb-[28px] text-[28px] text-white/60">
          {combo.longDescription || combo.shortDescription}
        </p>
        <p className="mb-[20px] text-[24px] text-white/45">
          Your afternoon, step by step — the logo shows where each part happens. Racer accounts
          &amp; waivers are set up right here.
        </p>
        <div className="relative space-y-[20px]">
          {combo.components.map((leg, i) => {
            const { title, sub } = legLabel(leg);
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
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={venue.logo}
                      alt={venue.name}
                      className="h-[52px] w-[104px] object-contain"
                    />
                    <span className="text-[18px] uppercase tracking-widest text-white/40">
                      at {venue.name}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {included.length > 0 && (
          <div className="k-glass mt-[28px] p-[28px]">
            <div className="k-eyebrow mb-[16px] text-[#46d68c]">All included in the price</div>
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

        {minHead > 1 && (
          <p className="mt-[24px] text-center text-[24px] text-[#e8b14c]/80">
            This experience is for {minHead}+ guests.
          </p>
        )}
      </div>

      <div className="k-z-actions">
        <button type="button" onClick={onBack} className="k-btn-ghost k-tap">
          Back
        </button>
        <button
          type="button"
          onClick={available ? onStart : undefined}
          disabled={!available}
          className="k-btn-primary k-tap disabled:opacity-40"
        >
          {available ? (
            <>
              <span className="k-num">${(perPerson / 100).toFixed(0)}</span>/person · Let&rsquo;s
              set it up
            </>
          ) : (
            "Not available right now"
          )}
        </button>
      </div>
    </>
  );
}
