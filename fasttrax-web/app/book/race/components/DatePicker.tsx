"use client";

import { useState, useEffect, useCallback } from "react";
import { bmiGet } from "../data";

interface DatePickerProps {
  /** Optional product to check availability for. If null, uses a default Starter product. */
  productId?: string;
  selected: string | null; // ISO date string YYYY-MM-DD
  onSelect: (date: string) => void;
}

// Mega product (Tuesdays — full combined track)
const MEGA_PRODUCT_ID = "24965505";
// Regular products covering weekdays + weekends
const REGULAR_PRODUCT_IDS = [
  "24960859",  // Starter Race Red (Mon-Thu)
  "24953280",  // Starter Race Red (Fri-Sun)
];

interface BmiActivity {
  date: string; // e.g. "2026-04-07T00:00:00"
  status: number; // 0=Available, 1=FullyBooked
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

async function fetchCalendarDays(productId: string, dateFrom: string, dateTill: string): Promise<string[]> {
  try {
    const data = await bmiGet("availability", { productId, dateFrom, dateTill });
    const activities: BmiActivity[] = data.activities || [];
    return activities
      .filter((a) => a.status === 0)
      .map((a) => a.date.split("T")[0]);
  } catch {
    return [];
  }
}

export default function DatePicker({ productId, selected, onSelect }: DatePickerProps) {
  const today = new Date();
  const todayStr = toISO(today.getFullYear(), today.getMonth(), today.getDate());

  // Always start on the current month — the useEffect will auto-advance
  // to next month once availability is fetched and no future dates exist.
  // (Previously this jumped to next month when today was the last day of
  // the month, which prevented booking on the final day e.g. Apr 30.)
  const init = { year: today.getFullYear(), month: today.getMonth() };

  const [viewYear, setViewYear] = useState(init.year);
  const [viewMonth, setViewMonth] = useState(init.month);
  const [availableDates, setAvailableDates] = useState<Set<string>>(new Set());
  const [megaDates, setMegaDates] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedNoFuture, setCheckedNoFuture] = useState(false);
  // Hide the calendar grid until the initial month probe completes so users
  // never see the jarring "April empty → snap to May" flash.
  const [ready, setReady] = useState(false);

  const fetchAvailability = useCallback(async (year: number, month: number) => {
    setLoading(true);
    setError(null);
    try {
      const dateFrom = `${year}-${String(month + 1).padStart(2, "0")}-01`;
      const lastDay = getDaysInMonth(year, month);
      const dateTill = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

      // BMI's GET /availability date-level endpoint can return status:1 for today
      // even when session-level slots exist (the POST /availability endpoint is
      // authoritative). Always force today into the available set when it falls in
      // the viewed month — the HeatPicker is the definitive gate.
      const forceToday = todayStr >= dateFrom && todayStr <= dateTill ? [todayStr] : [];

      if (productId) {
        const days = await fetchCalendarDays(productId, dateFrom, dateTill);
        const all = [...new Set([...days, ...forceToday])];
        setAvailableDates(new Set(all));
        setMegaDates(new Set());
        return { all, mega: [] as string[] };
      } else {
        const [megaDays, ...regularResults] = await Promise.all([
          fetchCalendarDays(MEGA_PRODUCT_ID, dateFrom, dateTill),
          ...REGULAR_PRODUCT_IDS.map(id => fetchCalendarDays(id, dateFrom, dateTill)),
        ]);

        const allDates = new Set<string>([...megaDays, ...regularResults.flat(), ...forceToday]);
        setAvailableDates(allDates);
        setMegaDates(new Set(megaDays));
        return { all: [...allDates], mega: megaDays };
      }
    } catch {
      setError("Couldn't load availability. Please try again.");
      return { all: [] as string[], mega: [] as string[] };
    } finally {
      setLoading(false);
    }
  }, [productId, todayStr]);

  useEffect(() => {
    fetchAvailability(viewYear, viewMonth).then(({ all }) => {
      if (!checkedNoFuture) {
        // Initial probe: advance to next month if nothing bookable remains
        setCheckedNoFuture(true);
        const futureDates = all.filter(d => d >= todayStr);
        if (futureDates.length === 0) {
          // Silently advance — the calendar stays hidden (ready=false) until
          // the next month's data arrives, so the user never sees the flash.
          if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
          else setViewMonth(m => m + 1);
          // ready stays false; the next effect run will set it true
        } else {
          setReady(true);
        }
      } else {
        // Second run (after advance) or a user-triggered month nav — show calendar
        setReady(true);
      }
    });
  }, [viewYear, viewMonth, fetchAvailability, checkedNoFuture, todayStr]);

  const prevMonth = () => {
    setReady(true); // already probed; manual nav always reveals calendar
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  };

  const nextMonth = () => {
    setReady(true);
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  };

  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDow = getFirstDayOfWeek(viewYear, viewMonth);
  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const canPrev = !(viewYear === today.getFullYear() && viewMonth === today.getMonth());

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-2">
          Pick a Date
        </h2>
        <p className="text-white/50 text-sm">
          Choose when you&apos;d like to race.
        </p>
      </div>

      {/* Spinner shown while probing the initial month (hides the April→May flash) */}
      {!ready && (
        <div className="h-48 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-white/20 border-t-white/80 rounded-full animate-spin" />
        </div>
      )}

      <div className="max-w-sm mx-auto" style={{ display: ready ? undefined : "none" }}>
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
            <div key={d} className="text-center text-[13px] text-white/30 py-1">{d}</div>
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
            {Array.from({ length: firstDow }).map((_, i) => (
              <div key={`empty-${i}`} />
            ))}

            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const dateStr = toISO(viewYear, viewMonth, day);
              const isPast = dateStr < todayStr;
              const isAvailable = availableDates.has(dateStr);
              const isMega = megaDates.has(dateStr);
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
                      ? isMega
                        ? "bg-[#A855F7] text-white font-bold shadow-lg shadow-[#A855F7]/30"
                        : "bg-[#00E2E5] text-[#000418] font-bold shadow-lg shadow-[#00E2E5]/30"
                      : isAvailable && !isPast
                        ? isMega
                          ? "bg-[#A855F7]/20 text-[#C084FC] hover:bg-[#A855F7]/35 cursor-pointer"
                          : "bg-[#00E2E5]/15 text-[#00E2E5] hover:bg-[#00E2E5]/30 cursor-pointer"
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
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 mt-4 text-[13px] text-white/40">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded bg-[#00E2E5]/15" />
            <span>Available</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded bg-[#A855F7]/20 ring-1 ring-[#A855F7]/50" />
            <span>Mega Track</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded bg-white/5" />
            <span>Unavailable</span>
          </div>
        </div>

        {/* Mega explainer */}
        {megaDates.size > 0 && (
          <div className="mt-3 rounded-xl border border-[#A855F7]/20 bg-[#A855F7]/5 p-3 text-center">
            <p className="text-[#C084FC] text-xs font-semibold mb-0.5">Mega Track Tuesdays</p>
            <p className="text-white/40 text-[13px] leading-relaxed">
              Blue &amp; Red tracks combine into one massive circuit!
            </p>
          </div>
        )}

        {availableDates.size === 0 && !loading && !error && (
          <p className="text-center text-white/40 text-sm mt-4">
            No available dates this month. Try the next month.
          </p>
        )}
      </div>
    </div>
  );
}
