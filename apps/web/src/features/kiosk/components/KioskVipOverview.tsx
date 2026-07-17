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
import { comboPriceCentsForDate, comboMinHeadcount } from "~/features/combos/combo-specials";
import { todayYmd } from "../service/first-available";

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

export function KioskVipOverview({
  combo,
  onStart,
  onBack,
}: {
  combo: ComboSpecial;
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
      </div>

      <div className="k-flow-body">
        <p className="mb-[28px] text-[28px] text-white/60">
          Everything below on one easy price — racer accounts &amp; waivers set up right here.
        </p>
        <div className="relative space-y-[20px]">
          {combo.components.map((leg, i) => {
            const { title, sub } = legLabel(leg);
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
                <div className="k-glass mb-[4px] flex-1 p-[24px]">
                  <div className="k-display text-[40px]">{title}</div>
                  <div className="mt-[6px] text-[26px] text-white/55">{sub}</div>
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
        <button type="button" onClick={onStart} className="k-btn-primary k-tap">
          <span className="k-num">${(perPerson / 100).toFixed(0)}</span>/person · Let&rsquo;s set it
          up
        </button>
      </div>
    </>
  );
}
