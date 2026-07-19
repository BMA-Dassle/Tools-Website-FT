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
} from "~/features/booking/service/bowling-hours";
import { todayYmd } from "../service/first-available";

type BowlingLikeItem = BowlingItem | KbfItem;

/** Vendor wall-clock ISO → center-local minutes-since-midnight (kiosk = today),
 *  in the same 0–26h notation the hour chips use (past-midnight → +24h). */
function wallMinutes(iso: string): number | null {
  const naive = iso.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
  const d = new Date(naive);
  if (Number.isNaN(d.getTime())) return null;
  const m = d.getHours() * 60 + d.getMinutes();
  return m < 6 * 60 ? m + 24 * 60 : m;
}

/** Same flat per-activity window the combo engine schedules with. */
const ASSUMED_ACTIVITY_MINUTES = 30;
/** Duration isn't picked until the offer step — assume the shortest session. */
const MIN_BOWLING_MINUTES = 60;

const KioskBowlingTimeStepComponent: StepDef<BowlingLikeItem>["Component"] = ({
  item,
  session,
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

  // 15-minute granularity from the ACTUAL current time — never show a past slot
  // as "next open" (owner: it showed 2:00 PM at 2:18 PM). Exact lane
  // availability is confirmed on the next step; this just offers real,
  // not-yet-passed start times. `new Date()` on the kiosk PC = center-local (ET).
  const openHours =
    item.date === today ? operatingHours(center.hpSlug, today, item.kind === "kbf") : [];
  const now = new Date();
  // operatingHours returns 0–26h notation (post-midnight = +24h, same as
  // wallMinutes) so a 1 AM slot sorts AFTER the evening, not before the morning.
  // Match "now" to it — otherwise, past midnight (still the current operating
  // day), the raw 0–23 clock reads as morning and every one of the day's hours
  // slips past the "not-yet-passed" filter.
  const rawNowMin = now.getHours() * 60 + now.getMinutes();
  const nowMin = now.getHours() < 6 ? rawNowMin + 24 * 60 : rawNowMin;
  const nextQuarter = Math.ceil(nowMin / 15) * 15;
  type Slot = { hour: number; minute: number };
  const slots: Slot[] = openHours
    .flatMap((h) => [0, 15, 30, 45].map((minute) => ({ hour: h, minute })))
    .filter((s) => s.hour * 60 + s.minute >= nextQuarter);

  // Conflict honoring (owner 2026-07-18: the rail "is not honoring the conflict
  // block"): times already booked THIS session block the bowling rail. Each
  // booked race heat / attraction slot occupies ~30 min; with the bowling
  // duration not yet picked (offer step, ≥60 min), a slot conflicts when a
  // 60-min session starting there would overlap a booked window.
  const busy: Array<{ startMin: number; endMin: number; label: string }> = [];
  for (const other of session.items) {
    if (other.id === item.id) continue;
    if (other.kind === "race") {
      const seen = new Set<string>();
      for (const h of other.heats) {
        if (!h.heatId || seen.has(h.heatId)) continue;
        seen.add(h.heatId);
        const m = wallMinutes(h.heatId);
        if (m != null)
          busy.push({ startMin: m, endMin: m + ASSUMED_ACTIVITY_MINUTES, label: "You're racing" });
      }
    } else if (other.kind === "attraction" && other.slot) {
      const m = wallMinutes(other.slot);
      if (m != null)
        busy.push({ startMin: m, endMin: m + ASSUMED_ACTIVITY_MINUTES, label: "You're booked" });
    } else if ((other.kind === "bowling" || other.kind === "kbf") && other.hour != null) {
      const start = other.hour * 60 + (other.minute ?? 0);
      busy.push({
        startMin: start,
        endMin: start + (other.durationMinutes ?? MIN_BOWLING_MINUTES),
        label: "You're bowling",
      });
    }
  }
  const conflictOf = (s: Slot): string | null => {
    const sStart = s.hour * 60 + s.minute;
    const sEnd = sStart + MIN_BOWLING_MINUTES;
    const hit = busy.find((b) => sStart < b.endMin && sEnd > b.startMin);
    return hit ? hit.label : null;
  };
  const anyConflicts = slots.some((s) => conflictOf(s) != null);

  // The hero "bowl now" pick skips conflicted times — first CLEAR slot wins.
  const first = slots.find((s) => !conflictOf(s)) ?? null;
  const isSel = (s: Slot) => item.hour === s.hour && item.minute === s.minute;
  const heroSelected = first != null && isSel(first);

  const pick = (s: Slot) => {
    if (conflictOf(s)) return;
    onChange({ hour: s.hour, minute: s.minute } as Partial<BowlingLikeItem>);
  };

  return (
    <div className="space-y-[32px]">
      {first != null ? (
        <button
          type="button"
          onClick={() => pick(first)}
          className="k-glass k-tap w-full p-[40px] text-left"
          style={{ borderLeft: `8px solid ${heroSelected ? "#fd5b56" : "rgba(255,255,255,0.15)"}` }}
        >
          <div className="k-eyebrow" style={{ color: "#fd5b56" }}>
            Next open lanes · today at {center.name}
          </div>
          <div className="k-display mt-[10px] text-[150px] leading-none tabular-nums">
            {bowlingTimeLabel(first.hour, first.minute)}
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

      {slots.length > 1 && (
        <div>
          <div className="k-eyebrow mb-[16px] text-white/40">Or pick another time today</div>
          <div className="grid grid-cols-4 gap-[14px]">
            {slots.map((s) => {
              const conflict = conflictOf(s);
              return (
                <button
                  key={`${s.hour}:${s.minute}`}
                  type="button"
                  onClick={() => pick(s)}
                  disabled={!!conflict}
                  title={conflict ?? undefined}
                  className={`k-chip k-tap ${isSel(s) ? "sel" : ""} ${
                    conflict ? "opacity-35 line-through" : ""
                  }`}
                >
                  {bowlingTimeLabel(s.hour, s.minute)}
                </button>
              );
            })}
          </div>
          <p className="mt-[16px] text-[24px] text-white/40">
            {anyConflicts
              ? "Crossed-out times overlap something you've already booked this visit. "
              : ""}
            Exact lane availability is confirmed on the next step — if a time just filled,
            we&rsquo;ll offer the closest open one.
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
