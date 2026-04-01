"use client";

import { useState, useEffect, useCallback } from "react";
import type { RaceProduct } from "../data";

interface DatePickerProps {
  race: RaceProduct;
  selected: string | null; // ISO date string YYYY-MM-DD
  onSelect: (date: string) => void;
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}

function toISO(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export default function DatePicker({ race, selected, onSelect }: DatePickerProps) {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [availableDates, setAvailableDates] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAvailability = useCallback(async (year: number, month: number) => {
    setLoading(true);
    setError(null);
    try {
      const dateFrom = `${year}-${String(month + 1).padStart(2, "0")}-01`;
      const lastDay = getDaysInMonth(year, month);
      const dateUntil = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

      const res = await fetch("/api/sms?endpoint=dayplanner%2Fcalendarrange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productId: race.productId,
          pageId: race.pageId,
          quantity: 1,
          dateFrom,
          dateUntil,
        }),
      });

      if (!res.ok) throw new Error("Failed to fetch availability");
      const data = await res.json();

      const dates = new Set<string>(
        (data.days || []).map((d: string) => d.split("T")[0])
      );
      setAvailableDates(dates);
    } catch {
      setError("Couldn't load availability. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [race.productId, race.pageId]);

  useEffect(() => {
    fetchAvailability(viewYear, viewMonth);
  }, [viewYear, viewMonth, fetchAvailability]);

  const prevMonth = () => {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  };

  const nextMonth = () => {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  };

  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDow = getFirstDayOfWeek(viewYear, viewMonth);
  const todayStr = toISO(today.getFullYear(), today.getMonth(), today.getDate());
  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const canPrev = !(viewYear === today.getFullYear() && viewMonth === today.getMonth());

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-2">
          Pick a Date
        </h2>
        <p className="text-white/50 text-sm">
          Showing availability for <span className="text-white/80">{race.displayName}</span>
        </p>
      </div>

      <div className="max-w-sm mx-auto">
        {/* Month nav */}
        <div className="flex items-center justify-between mb-4">
          <button
            onClick={prevMonth}
            disabled={!canPrev}
            className="p-2 rounded-lg text-white/50 hover:text-white hover:bg-white/10 disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
          >
            ←
          </button>
          <span className="text-white font-semibold">{monthLabel}</span>
          <button
            onClick={nextMonth}
            className="p-2 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors"
          >
            →
          </button>
        </div>

        {/* Day-of-week headers */}
        <div className="grid grid-cols-7 mb-1">
          {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
            <div key={d} className="text-center text-[11px] text-white/30 py-1">{d}</div>
          ))}
        </div>

        {/* Calendar grid */}
        {loading ? (
          <div className="h-48 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-white/20 border-t-white/80 rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="h-48 flex flex-col items-center justify-center gap-2">
            <p className="text-red-400 text-sm">{error}</p>
            <button
              onClick={() => fetchAvailability(viewYear, viewMonth)}
              className="text-xs text-white/50 hover:text-white underline"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-7 gap-1">
            {/* Empty cells before first day */}
            {Array.from({ length: firstDow }).map((_, i) => (
              <div key={`empty-${i}`} />
            ))}

            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const dateStr = toISO(viewYear, viewMonth, day);
              const isPast = dateStr < todayStr;
              const isAvailable = availableDates.has(dateStr);
              const isSelected = selected === dateStr;
              const isToday = dateStr === todayStr;

              return (
                <button
                  key={day}
                  onClick={() => isAvailable && !isPast && onSelect(dateStr)}
                  disabled={!isAvailable || isPast}
                  className={`
                    aspect-square rounded-lg text-sm font-medium transition-all duration-150
                    ${isSelected
                      ? "bg-[#00E2E5] text-[#000418] font-bold shadow-lg shadow-[#00E2E5]/30"
                      : isAvailable && !isPast
                        ? "bg-[#00E2E5]/15 text-[#00E2E5] hover:bg-[#00E2E5]/30 cursor-pointer"
                        : "text-white/20 cursor-not-allowed"
                    }
                    ${isToday && !isSelected ? "ring-1 ring-white/30" : ""}
                  `}
                >
                  {day}
                </button>
              );
            })}
          </div>
        )}

        {/* Legend */}
        <div className="flex items-center justify-center gap-4 mt-4 text-[11px] text-white/40">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded bg-[#00E2E5]/15" />
            <span>Available</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded bg-[#00E2E5]" />
            <span>Selected</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded bg-white/5" />
            <span>Unavailable</span>
          </div>
        </div>

        {availableDates.size === 0 && !loading && !error && (
          <p className="text-center text-white/40 text-sm mt-4">
            No available dates this month. Try the next month.
          </p>
        )}
      </div>
    </div>
  );
}
