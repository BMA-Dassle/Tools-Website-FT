"use client";

import { useEffect, useMemo, useState } from "react";
import type { BowlingItem, KbfItem, StepDef } from "~/features/booking";
import {
  bowlingHorizonMaxDate,
  bowlingTimeLabel,
  CENTERS,
  effectiveToday,
  operatingHours,
  otherActivitiesOnDate,
  type OtherActivity,
} from "~/features/booking/service/bowling-hours";
import { formatHourLabel } from "./availability-client";

// Bowling wizard accent — owner 2026-07-19: bowling reads BLUE ("red just
// seems negative"); FastTrax red stays on racing only. VIP keeps gold.
const BLUE = "#00E2E5";
const CYAN = "#00E2E5";
// Conflict markers were cyan-on-coral; with the blue accent they need a
// distinct hue to stay visible.
const AMBER = "#f59e0b";

// Static hours/date helpers moved verbatim to
// ~/features/booking/service/bowling-hours (2026-07-19) so kiosk + v3 steps
// share them without importing this component. Re-exported for existing
// importers (KioskBowlingTimeStep et al.).
export { bowlingTimeLabel, CENTERS, operatingHours };

type BowlingLikeItem = BowlingItem | KbfItem;

const BowlingSlotsStepComponent: StepDef<BowlingLikeItem>["Component"] = ({
  item,
  session,
  onChange,
}) => {
  const centerId = item.qamfCenterId ?? 9172;
  const center = CENTERS[centerId] ?? CENTERS[9172];

  const earliest = effectiveToday();
  const maxDate = bowlingHorizonMaxDate();

  // Is there a date on another cart item we can inherit?
  const cartDate = session.items.reduce<string | null>((found, other) => {
    if (found) return found;
    if (other.id === item.id) return null;
    const d = "date" in other ? (other as { date?: string | null }).date : null;
    return d && d >= earliest && d <= maxDate ? d : null;
  }, null);

  const [showCalendar, setShowCalendar] = useState(!cartDate);

  const selectedDate = item.date ?? "";

  // Static operating hours for the chosen date — NO QAMF probe, so the chips
  // load instantly. Real availability is resolved on the package step (which
  // probes the chosen hour and widens to next-available if it's full).
  const availableHours = useMemo(
    () => (selectedDate ? operatingHours(center.hpSlug, selectedDate, item.kind === "kbf") : []),
    [center.hpSlug, selectedDate, item.kind],
  );

  // Other cart activities on this date — listed + marked on the chips so the
  // customer can pick a bowling time around them.
  const otherActivities = useMemo(
    () => (selectedDate ? otherActivitiesOnDate(session, item.id, selectedDate) : []),
    [session, item.id, selectedDate],
  );
  const conflictByHour = useMemo(() => {
    const m = new Map<number, OtherActivity[]>();
    for (const a of otherActivities) {
      if (a.hour == null) continue;
      m.set(a.hour, [...(m.get(a.hour) ?? []), a]);
    }
    return m;
  }, [otherActivities]);

  // Auto-select date from other cart items if this is a new item with no date
  useEffect(() => {
    if (item.date) return;
    if (cartDate) {
      onChange({ date: cartDate } as Partial<BowlingLikeItem>);
    }
  }, []);

  // Default the time to the first operating hour (or re-default when the prior
  // pick is no longer valid for this date). An explicit, still-valid pick stays.
  useEffect(() => {
    if (!availableHours.length) return;
    if (item.hour != null && availableHours.includes(item.hour)) return;
    onChange({ hour: availableHours[0], minute: 0 } as Partial<BowlingLikeItem>);
  }, [availableHours, item.hour]);

  const [calMonth, setCalMonth] = useState(() => {
    const seed = item.date ?? cartDate;
    const d = seed ? new Date(`${seed}T12:00:00`) : new Date();
    return d.getMonth();
  });
  const [calYear, setCalYear] = useState(() => {
    const seed = item.date ?? cartDate;
    const d = seed ? new Date(`${seed}T12:00:00`) : new Date();
    return d.getFullYear();
  });

  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const monthName = new Date(calYear, calMonth).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });

  function isBookableDate(dateStr: string): boolean {
    return dateStr >= earliest && dateStr <= maxDate;
  }

  function selectDate(dateStr: string) {
    // Reset hour → the date-change effect re-seeds the start time for the new date.
    onChange({
      date: dateStr,
      hour: null,
      minute: null,
      bookedAt: null,
    } as Partial<BowlingLikeItem>);
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      {/* Context bar */}
      <div className="flex flex-wrap items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5 text-xs uppercase tracking-wider text-white/55">
        <span style={{ color: BLUE }}>{center.name}</span>
        {selectedDate && (
          <>
            <span className="text-white/20">&middot;</span>
            <span>
              {new Date(`${selectedDate}T12:00:00`).toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}
            </span>
          </>
        )}
      </div>

      {/* Compact date confirmation when inherited from cart */}
      {!showCalendar ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-[#00E2E5]/20 bg-[#00E2E5]/5 p-5 text-center">
          <p className="text-xs uppercase tracking-[3px] text-white/35">Date</p>
          <p className="mt-2 text-sm text-white/50">Same day as your other activities</p>
          <p className="mt-1 text-lg font-bold text-white">
            {selectedDate
              ? new Date(`${selectedDate}T12:00:00`).toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })
              : ""}
          </p>
          <button
            type="button"
            onClick={() => setShowCalendar(true)}
            className="mt-3 text-xs text-white/40 underline hover:text-white/60"
          >
            Choose a different date
          </button>
        </div>
      ) : (
        /* Calendar */
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="mb-3 text-center text-xs uppercase tracking-[3px] text-white/35">
            Date
          </div>
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                if (calMonth === 0) {
                  setCalMonth(11);
                  setCalYear(calYear - 1);
                } else setCalMonth(calMonth - 1);
              }}
              className="p-2 text-white/50 hover:text-white"
              aria-label="Previous month"
            >
              &larr;
            </button>
            <span className="text-sm font-bold text-white">{monthName}</span>
            <button
              type="button"
              onClick={() => {
                if (calMonth === 11) {
                  setCalMonth(0);
                  setCalYear(calYear + 1);
                } else setCalMonth(calMonth + 1);
              }}
              className="p-2 text-white/50 hover:text-white"
              aria-label="Next month"
            >
              &rarr;
            </button>
          </div>
          <div className="mb-1 grid grid-cols-7">
            {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
              <div key={d} className="py-1 text-center text-[12px] text-white/30">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: firstDay }).map((_, i) => (
              <div key={`pad-${i}`} />
            ))}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              const bookable = isBookableDate(dateStr);
              const isSelected = dateStr === selectedDate;
              return (
                <button
                  key={day}
                  type="button"
                  disabled={!bookable}
                  onClick={() => selectDate(dateStr)}
                  className="aspect-square rounded-lg text-sm font-medium transition-all duration-150"
                  style={{
                    backgroundColor: isSelected
                      ? BLUE
                      : bookable
                        ? "rgba(0,226,229,0.15)"
                        : "transparent",
                    color: isSelected ? "#0a1628" : bookable ? BLUE : "rgba(255,255,255,0.18)",
                    fontWeight: isSelected ? 800 : 500,
                    cursor: bookable ? "pointer" : "not-allowed",
                    boxShadow: isSelected ? `0 0 14px ${BLUE}60` : undefined,
                  }}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Already-booked activities this day — so they can plan bowling around them */}
      {selectedDate && otherActivities.length > 0 && (
        <div
          className="rounded-2xl border p-4"
          style={{ borderColor: `${CYAN}40`, backgroundColor: `${CYAN}0f` }}
        >
          <div
            className="mb-2 text-center text-[11px] uppercase tracking-[2px]"
            style={{ color: CYAN }}
          >
            Also booked this day
          </div>
          <ul className="space-y-1.5">
            {otherActivities.map((a) => (
              <li key={a.key} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-white/85">
                  <span>{a.icon}</span>
                  {a.label}
                </span>
                <span className="font-semibold text-white">{a.timeLabel}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-center text-[11px] text-white/40">
            Pick a bowling time that works around these — marked below.
          </p>
        </div>
      )}

      {/* Time — static operating hours under the calendar (no probe; the package
          step checks real availability for the chosen hour) */}
      {selectedDate && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="mb-3 text-center text-xs uppercase tracking-[3px] text-white/35">
            Time
          </div>
          {availableHours.length === 0 ? (
            <p className="py-4 text-center text-sm text-white/40">
              No bowling hours this day. Try another date.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {availableHours.map((h) => {
                  const isSel = item.hour === h;
                  const conflicts = conflictByHour.get(h) ?? [];
                  return (
                    <button
                      key={h}
                      type="button"
                      onClick={() =>
                        onChange({
                          hour: h,
                          minute: 0,
                          bookedAt: null,
                        } as Partial<BowlingLikeItem>)
                      }
                      title={
                        conflicts.length
                          ? `You're also booked: ${conflicts.map((c) => `${c.label} ${c.timeLabel}`).join(", ")}`
                          : undefined
                      }
                      className="flex flex-col items-center gap-0.5 rounded-xl px-3 py-2.5 text-sm font-semibold transition-all"
                      style={{
                        backgroundColor: isSel ? BLUE : "rgba(0,226,229,0.10)",
                        color: isSel ? "#0a1628" : BLUE,
                        fontWeight: isSel ? 800 : 600,
                        boxShadow: isSel ? `0 0 14px ${BLUE}60` : undefined,
                        border: conflicts.length ? `1px solid ${AMBER}99` : "1px solid transparent",
                      }}
                    >
                      <span>{formatHourLabel(h)}</span>
                      {conflicts.length > 0 && (
                        <span className="text-[10px] leading-none" aria-hidden>
                          {conflicts.map((c) => c.icon).join("")}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="mt-3 text-center text-[11px] text-white/35">
                We&apos;ll show exact start times &amp; packages next.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
};

const BowlingSlotsStep: StepDef<BowlingItem> = {
  id: "bowling-slots",
  title: "Date",
  Component: BowlingSlotsStepComponent as StepDef<BowlingItem>["Component"],
  isVisible: () => true,
  canAdvance: (item) =>
    !item.date ? { reason: "Pick a date" } : item.hour == null ? { reason: "Pick a time" } : true,
};

export default BowlingSlotsStep;
