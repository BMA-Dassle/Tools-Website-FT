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
    <div className="space-y-8">
      {firstHour != null ? (
        <button
          type="button"
          onClick={() => pick(firstHour)}
          className={`w-full rounded-3xl border-2 px-8 py-8 text-left transition-colors ${
            heroSelected ? "bg-white/[0.06]" : "bg-white/[0.03]"
          }`}
          style={{ borderColor: heroSelected ? "#fd5b56" : "rgba(255,255,255,0.15)" }}
        >
          <div className="font-heading text-sm font-bold uppercase tracking-[0.28em] text-[#fd5b56]">
            Next open lanes · today at {center.name}
          </div>
          <div className="font-heading mt-2 text-7xl font-extrabold italic leading-none tabular-nums">
            {bowlingTimeLabel(firstHour, 0)}
          </div>
          <div className="mt-3 text-lg text-white/60">
            {heroSelected
              ? "Locked in — hit Next to pick your lane package"
              : "Tap to bowl as soon as you're ready"}
          </div>
        </button>
      ) : (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-center text-lg text-white/55">
          No more lane times today — the front desk can help with walk-in availability.
        </div>
      )}

      {hours.length > 1 && (
        <div>
          <div className="font-heading mb-3 text-sm font-bold uppercase tracking-[0.24em] text-white/40">
            Or pick another time today
          </div>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {hours.map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => pick(h)}
                className={`rounded-2xl border-2 px-4 py-4 text-lg font-bold tabular-nums transition-colors ${
                  item.hour === h
                    ? "border-[#fd5b56] bg-[#fd5b56]/10 text-white"
                    : "border-white/10 bg-white/[0.02] text-white/60"
                }`}
              >
                {bowlingTimeLabel(h, 0)}
              </button>
            ))}
          </div>
          <p className="mt-3 text-sm text-white/40">
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
