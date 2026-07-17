"use client";

/**
 * Kiosk bowling time step — today only, "bowl now" first.
 *
 * Replaces the web's BowlingSlotsStep (date calendar + hour chips) in the
 * kiosk registry: no calendar (walk-up device — the date is today), a hero
 * card offers the earliest bookable hour in one tap, and today's remaining
 * hours render as a chip rail for "later today". Hours come from the SAME
 * exported operatingHours() the web step uses (static center hours; real
 * QAMF availability is resolved on the package/offer step, which widens to
 * next-available when an hour is full — web parity).
 */
import { useEffect } from "react";
import type { BowlingItem, KbfItem, StepDef } from "~/features/booking";
import {
  bowlingTimeLabel,
  CENTERS,
  operatingHours,
} from "~/components/features/booking/steps/bowling/BowlingSlotsStep";
import { todayYmd } from "../service/first-available";

type BowlingLikeItem = BowlingItem | KbfItem;

const KioskBowlingTimeStepComponent: StepDef<BowlingLikeItem>["Component"] = ({
  item,
  onChange,
}) => {
  const centerId = item.qamfCenterId ?? 9172;
  const center = CENTERS[centerId] ?? CENTERS[9172];
  const today = todayYmd();

  // Kiosk = walk-up: the date is always today.
  useEffect(() => {
    if (item.date !== today) {
      onChange({
        date: today,
        hour: null,
        minute: null,
        bookedAt: null,
      } as Partial<BowlingLikeItem>);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.date, today]);

  const hours =
    item.date === today ? operatingHours(center.hpSlug, today, item.kind === "kbf") : [];
  const firstHour = hours.length > 0 ? hours[0] : null;
  const heroSelected = firstHour != null && item.hour === firstHour;

  const pick = (h: number) => onChange({ hour: h, minute: 0 } as Partial<BowlingLikeItem>);

  return (
    <div className="space-y-[32px]">
      {firstHour != null ? (
        <button
          type="button"
          onClick={() => pick(firstHour)}
          className="k-glass k-tap w-full p-[40px] text-left"
          style={{ borderLeft: `8px solid ${heroSelected ? "#fd5b56" : "rgba(255,255,255,0.15)"}` }}
        >
          <div className="k-eyebrow" style={{ color: "#fd5b56" }}>
            Next open lanes · today at {center.name}
          </div>
          <div className="k-display mt-[10px] text-[150px] leading-none tabular-nums">
            {bowlingTimeLabel(firstHour, 0)}
          </div>
          <div className="mt-[12px] text-[28px] text-white/60">
            {heroSelected
              ? "Locked in — hit Continue to pick your lane package"
              : "Tap to bowl as soon as you're ready"}
          </div>
        </button>
      ) : (
        <div className="k-glass p-[32px] text-center text-[28px] text-white/55">
          No more lane times today — the front desk can help with walk-in availability.
        </div>
      )}

      {hours.length > 1 && (
        <div>
          <div className="k-eyebrow mb-[16px] text-white/40">Or pick another time today</div>
          <div className="grid grid-cols-4 gap-[14px]">
            {hours.map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => pick(h)}
                className={`k-chip k-tap ${item.hour === h ? "sel" : ""}`}
              >
                {bowlingTimeLabel(h, 0)}
              </button>
            ))}
          </div>
          <p className="mt-[16px] text-[24px] text-white/40">
            Exact lane availability is confirmed on the next step — if an hour just filled,
            we&rsquo;ll offer the closest open time.
          </p>
        </div>
      )}
    </div>
  );
};

export const KioskBowlingTimeStep: StepDef<BowlingLikeItem> = {
  id: "bowling-slots", // keep the web id: downstream steps + cursors align
  title: "Time",
  Component: KioskBowlingTimeStepComponent,
  isVisible: () => true,
  canAdvance: (item) =>
    !item.date ? { reason: "Pick a date" } : item.hour == null ? { reason: "Pick a time" } : true,
};
