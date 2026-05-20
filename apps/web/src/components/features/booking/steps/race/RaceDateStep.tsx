"use client";

import { useMemo, useState } from "react";
import type { RaceItem, StepDef } from "~/features/booking";

/**
 * Race step — pick the race day.
 *
 * UI is a stripped-down v1-style monthly calendar:
 *   - Mega Tuesdays render in purple (#A855F7).
 *   - Regular available days in cyan (#00E2E5/15 chip, full cyan when selected).
 *   - Past dates dimmed + non-clickable.
 *
 * PR-B2 commit 9a ships the calendar WITHOUT live BMI availability — every
 * non-past date is selectable, the HeatPicker step (commit 9b) is the real
 * "is anything bookable on this day?" gate. The wizard's UX stays
 * unchanged (v1 also forces today into the available set + treats
 * HeatPicker as the authoritative gate — see v1 `DatePicker.tsx:84`).
 *
 * When commit 9b adds BMI availability we'll fold in the actual probe
 * + dim-unavailable behavior, but the visual is already final.
 */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toISO(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function firstDayOfWeek(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

const MONTH_LABEL = (year: number, month: number) =>
  new Date(year, month, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

const RaceDateStepComponent: StepDef<RaceItem>["Component"] = ({ item, onChange }) => {
  const today = useMemo(() => new Date(), []);
  const todayStr = toISO(today.getFullYear(), today.getMonth(), today.getDate());

  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());

  const monthLabel = MONTH_LABEL(viewYear, viewMonth);
  const total = daysInMonth(viewYear, viewMonth);
  const firstDow = firstDayOfWeek(viewYear, viewMonth);

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  };
  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  // Prev nav disabled when viewing the current month (no past-month browsing).
  const canPrev =
    viewYear > today.getFullYear() ||
    (viewYear === today.getFullYear() && viewMonth > today.getMonth());

  const cells: Array<{ day: number; iso: string; isMega: boolean; isPast: boolean } | null> = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= total; d++) {
    const iso = toISO(viewYear, viewMonth, d);
    const isMega = new Date(viewYear, viewMonth, d).getDay() === 2; // Tuesday
    const isPast = iso < todayStr;
    cells.push({ day: d, iso, isMega, isPast });
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="font-display text-2xl uppercase tracking-widest text-white">Pick a Date</h3>
        <p className="mt-1 text-sm text-white/50">Choose when you&apos;d like to race.</p>
      </div>

      <div className="mx-auto max-w-sm">
        {/* Month nav */}
        <div className="mb-4 flex items-center justify-between">
          <button
            type="button"
            onClick={prevMonth}
            disabled={!canPrev}
            className="rounded-lg p-2 text-white/50 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-20"
            aria-label="Previous month"
          >
            ←
          </button>
          <span className="font-semibold text-white">{monthLabel}</span>
          <button
            type="button"
            onClick={nextMonth}
            className="rounded-lg p-2 text-white/50 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Next month"
          >
            →
          </button>
        </div>

        {/* Day-of-week headers */}
        <div className="mb-1 grid grid-cols-7">
          {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
            <div key={d} className="py-1 text-center text-[13px] text-white/30">
              {d}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="grid grid-cols-7 gap-1">
          {cells.map((cell, idx) => {
            if (!cell) return <div key={`pad-${idx}`} className="aspect-square" />;
            const { day, iso, isMega, isPast } = cell;
            const isSelected = item.date === iso;
            const isToday = iso === todayStr;
            return (
              <button
                key={iso}
                type="button"
                onClick={() => !isPast && onChange({ date: iso })}
                disabled={isPast}
                className={
                  "aspect-square rounded-lg text-sm font-medium transition-all duration-150 " +
                  (isSelected
                    ? isMega
                      ? "bg-[#A855F7] font-bold text-white shadow-lg shadow-[#A855F7]/30"
                      : "bg-[#00E2E5] font-bold text-[#000418] shadow-lg shadow-[#00E2E5]/30"
                    : isPast
                      ? "cursor-not-allowed text-white/20"
                      : isMega
                        ? "cursor-pointer bg-[#A855F7]/20 text-[#C084FC] hover:bg-[#A855F7]/35"
                        : "cursor-pointer bg-[#00E2E5]/15 text-[#00E2E5] hover:bg-[#00E2E5]/30") +
                  (isToday && !isSelected ? " ring-1 ring-white/30" : "")
                }
              >
                {day}
              </button>
            );
          })}
        </div>

        {/* Legend — matches v1 layout */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[13px] text-white/40">
          <div className="flex items-center gap-1.5">
            <div className="h-3 w-3 rounded bg-[#00E2E5]/15" />
            <span>Available</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-3 w-3 rounded bg-[#A855F7]/20 ring-1 ring-[#A855F7]/50" />
            <span>Mega Track</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export const RaceDateStep: StepDef<RaceItem> = {
  id: "race-date",
  title: "Date",
  Component: RaceDateStepComponent,
  isVisible: () => true,
  canAdvance: (item) => (item.date ? true : { reason: "Pick a race day to continue." }),
};
