"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AttractionItem, StepDef } from "~/features/booking";
import { resolveAttractionContext } from "~/features/booking/service/attractions";

interface BmiActivity {
  date: string;
  status: number;
}

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

async function fetchCalendarDays(
  productId: string,
  dateFrom: string,
  dateTill: string,
  clientKey?: string,
): Promise<string[]> {
  try {
    const params: Record<string, string> = {
      endpoint: "availability",
      productId,
      dateFrom,
      dateTill,
    };
    if (clientKey) params.clientKey = clientKey;
    const qs = new URLSearchParams(params);
    const res = await fetch(`/api/bmi?${qs.toString()}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { activities?: BmiActivity[] };
    return (data.activities ?? []).filter((a) => a.status === 0).map((a) => a.date.split("T")[0]);
  } catch {
    return [];
  }
}

const AttractionDateStepComponent: StepDef<AttractionItem>["Component"] = ({
  item,
  session,
  onChange,
}) => {
  const ctx = useMemo(
    () => (item.slug ? resolveAttractionContext(item.slug, session) : null),
    [item.slug, session],
  );

  const today = useMemo(() => new Date(), []);
  const todayStr = toISO(today.getFullYear(), today.getMonth(), today.getDate());

  // Default date from existing cart items (race date, bowling date, or another attraction)
  const cartDate = useMemo(() => {
    if (item.date) return item.date;
    for (const other of session.items) {
      if (other.id === item.id) continue;
      const d = "date" in other ? (other as { date?: string | null }).date : null;
      if (d) return d;
    }
    return null;
  }, [item.date, item.id, session.items]);

  const [viewYear, setViewYear] = useState(() => {
    if (cartDate) return parseInt(cartDate.split("-")[0], 10);
    return today.getFullYear();
  });
  const [viewMonth, setViewMonth] = useState(() => {
    if (cartDate) return parseInt(cartDate.split("-")[1], 10) - 1;
    return today.getMonth();
  });
  const [availableDates, setAvailableDates] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedNoFuture, setCheckedNoFuture] = useState(false);
  const [ready, setReady] = useState(false);

  const accentColor = ctx?.config.color ?? "#00E2E5";

  const fetchAvailability = useCallback(
    async (year: number, month: number) => {
      if (!item.productId) return { all: [] as string[] };
      setLoading(true);
      setError(null);
      try {
        const dateFrom = `${year}-${pad(month + 1)}-01`;
        const lastDay = daysInMonth(year, month);
        const dateTill = `${year}-${pad(month + 1)}-${pad(lastDay)}`;

        const days = await fetchCalendarDays(item.productId, dateFrom, dateTill, ctx?.clientKey);
        const dateSet = new Set(days);
        setAvailableDates(dateSet);
        return { all: days };
      } catch {
        setError("Couldn't load availability. Please try again.");
        return { all: [] as string[] };
      } finally {
        setLoading(false);
      }
    },
    [item.productId, ctx?.clientKey],
  );

  useEffect(() => {
    fetchAvailability(viewYear, viewMonth).then(({ all }) => {
      if (!checkedNoFuture) {
        setCheckedNoFuture(true);
        const futureDates = all.filter((d) => d >= todayStr);
        if (futureDates.length === 0) {
          if (viewMonth === 11) {
            setViewYear((y) => y + 1);
            setViewMonth(0);
          } else {
            setViewMonth((m) => m + 1);
          }
        } else {
          setReady(true);
          // Auto-select the cart date if it's available and no date picked yet
          if (!item.date && cartDate && futureDates.includes(cartDate)) {
            onChange({ date: cartDate });
          }
        }
      } else {
        setReady(true);
      }
    });
  }, [
    viewYear,
    viewMonth,
    fetchAvailability,
    checkedNoFuture,
    todayStr,
    cartDate,
    item.date,
    onChange,
  ]);

  const monthLabel = MONTH_LABEL(viewYear, viewMonth);
  const total = daysInMonth(viewYear, viewMonth);
  const firstDow = firstDayOfWeek(viewYear, viewMonth);

  const prevMonth = () => {
    setReady(true);
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  };
  const nextMonth = () => {
    setReady(true);
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const canPrev =
    viewYear > today.getFullYear() ||
    (viewYear === today.getFullYear() && viewMonth > today.getMonth());

  // When date is pre-selected from cart, show compact confirmation
  const [showCalendar, setShowCalendar] = useState(!cartDate);

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="font-display text-2xl uppercase tracking-widest text-white">Pick a Date</h3>
        <p className="mt-1 text-sm text-white/50">
          Choose when you&apos;d like to{" "}
          {ctx?.config.shortName ? `play ${ctx.config.shortName}` : "visit"}.
        </p>
      </div>

      {/* Pre-selected date from cart — compact confirmation */}
      {item.date && !showCalendar && (
        <div className="mx-auto max-w-sm rounded-xl border border-[#00E2E5]/20 bg-[#00E2E5]/5 p-4 text-center">
          <p className="text-sm text-white/50">Same day as your other activities</p>
          <p className="mt-1 text-lg font-bold text-white">
            {new Date(item.date + "T12:00:00").toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </p>
          <button
            type="button"
            onClick={() => setShowCalendar(true)}
            className="mt-2 text-xs text-white/40 underline hover:text-white/60"
          >
            Choose a different date
          </button>
        </div>
      )}

      {!ready && showCalendar && (
        <div className="flex h-48 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
        </div>
      )}

      <div
        className="mx-auto max-w-sm"
        style={{ display: ready && showCalendar ? undefined : "none" }}
      >
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

        <div className="mb-1 grid grid-cols-7">
          {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
            <div key={d} className="py-1 text-center text-[13px] text-white/30">
              {d}
            </div>
          ))}
        </div>

        {loading ? (
          <div className="flex h-48 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          </div>
        ) : error ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2">
            <p className="text-sm text-red-400">{error}</p>
            <button
              type="button"
              onClick={() => fetchAvailability(viewYear, viewMonth)}
              className="text-xs text-white/50 underline hover:text-white"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: firstDow }).map((_, i) => (
              <div key={`pad-${i}`} className="aspect-square" />
            ))}

            {Array.from({ length: total }).map((_, i) => {
              const day = i + 1;
              const iso = toISO(viewYear, viewMonth, day);
              const isPast = iso < todayStr;
              const isAvailable = availableDates.has(iso);
              const isSelected = item.date === iso;
              const isToday = iso === todayStr;

              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() =>
                    isAvailable &&
                    !isPast &&
                    onChange({ date: iso, slot: null, slotProposal: null })
                  }
                  disabled={!isAvailable || isPast}
                  className={
                    "aspect-square rounded-lg text-sm font-medium transition-all duration-150 " +
                    (isSelected
                      ? "font-bold text-[#000418] shadow-lg"
                      : isAvailable && !isPast
                        ? "cursor-pointer text-white/80 hover:bg-white/10"
                        : "cursor-not-allowed text-white/8") +
                    (isToday && !isSelected ? " ring-1 ring-white/30" : "")
                  }
                  style={
                    isSelected
                      ? {
                          backgroundColor: accentColor,
                          boxShadow: `0 4px 14px ${accentColor}40`,
                        }
                      : isAvailable && !isPast
                        ? { backgroundColor: `${accentColor}18` }
                        : undefined
                  }
                >
                  {day}
                </button>
              );
            })}
          </div>
        )}

        {availableDates.size === 0 && !loading && !error && (
          <p className="mt-4 text-center text-sm text-white/40">
            No available dates this month. Try the next month.
          </p>
        )}
      </div>
    </div>
  );
};

export const AttractionDateStep: StepDef<AttractionItem> = {
  id: "attraction-date",
  title: "Date",
  Component: AttractionDateStepComponent,
  isVisible: () => true,
  canAdvance: (item) => {
    if (!item.date) return { reason: "Pick a date to continue." };
    return true;
  },
};
