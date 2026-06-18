"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PartyMember, RaceItem, StepDef } from "~/features/booking";
import { getGroupEventForDate, getPublicReopenTimeForDate } from "@/lib/group-events";

/**
 * Race step — pick the race day.
 *
 * v1 parity: full port of `apps/web/app/book/race/components/DatePicker.tsx`.
 * Probes BMI per-month availability for both regular tracks (Mon-Thu Starter
 * Red + Fri-Sun Starter Red) and the Mega track (Tuesdays only) so each
 * cell knows whether it's available, mega-only, or neither. Cells reserved
 * for private group events (`getGroupEventForDate`) render amber + unclickable.
 *
 * Inline warning surface (v1 page.tsx:2001-2068): when the customer picks a
 * Tuesday AND the party contains a new junior racer, the "Heads up — Mega
 * Tuesday" amber banner renders below the calendar and `canAdvance` blocks
 * Next until they pick a different date or change party. v1 calls Mega
 * Tuesdays the only day juniors can't run a starter race (Mega has no
 * Junior Starter product).
 *
 * Imports v1's `getGroupEventForDate` from `lib/group-events.ts` directly —
 * static config registry, shared between v1 + v2.
 */

// BMI products v2 probes for per-month availability — same trio as v1.
const MEGA_PRODUCT_ID = "24965505";
const REGULAR_PRODUCT_IDS = [
  "24960859", // Starter Race Red (Mon-Thu)
  "24953280", // Starter Race Red (Fri-Sun)
];

interface BmiActivity {
  date: string; // "2026-04-07T00:00:00"
  status: number; // 0=Available, 1=FullyBooked
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
): Promise<string[]> {
  try {
    const qs = new URLSearchParams({
      endpoint: "availability",
      productId,
      dateFrom,
      dateTill,
    });
    const res = await fetch(`/api/bmi?${qs.toString()}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { activities?: BmiActivity[] };
    const activities = data.activities ?? [];
    return activities.filter((a) => a.status === 0).map((a) => a.date.split("T")[0]);
  } catch {
    return [];
  }
}

function partyHasNewJuniors(party: PartyMember[]): boolean {
  return party.some((m) => (m.category ?? "adult") === "junior" && m.isNewRacer);
}

function isTuesdayISO(iso: string): boolean {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).getDay() === 2;
}

const RaceDateStepComponent: StepDef<RaceItem>["Component"] = ({ item, session, onChange }) => {
  const today = useMemo(() => new Date(), []);
  const todayStr = toISO(today.getFullYear(), today.getMonth(), today.getDate());

  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [availableDates, setAvailableDates] = useState<Set<string>>(new Set());
  const [megaDates, setMegaDates] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedNoFuture, setCheckedNoFuture] = useState(false);
  // Hide grid until initial probe completes — v1's "no Apr → May flash" trick.
  const [ready, setReady] = useState(false);

  const fetchAvailability = useCallback(
    async (year: number, month: number) => {
      setLoading(true);
      setError(null);
      try {
        const dateFrom = `${year}-${pad(month + 1)}-01`;
        const lastDay = daysInMonth(year, month);
        const dateTill = `${year}-${pad(month + 1)}-${pad(lastDay)}`;

        const [megaDays, ...regularResults] = await Promise.all([
          fetchCalendarDays(MEGA_PRODUCT_ID, dateFrom, dateTill),
          ...REGULAR_PRODUCT_IDS.map((id) => fetchCalendarDays(id, dateFrom, dateTill)),
        ]);

        const allDates = new Set<string>([...megaDays, ...regularResults.flat()]);
        setAvailableDates(allDates);
        setMegaDates(new Set(megaDays));
        return { all: [...allDates], mega: megaDays };
      } catch {
        setError("Couldn’t load availability. Please try again.");
        return { all: [] as string[], mega: [] as string[] };
      } finally {
        setLoading(false);
      }
    },
    [todayStr],
  );

  useEffect(() => {
    fetchAvailability(viewYear, viewMonth).then(({ all }) => {
      if (!checkedNoFuture) {
        setCheckedNoFuture(true);
        const futureDates = all.filter((d) => d >= todayStr);
        if (futureDates.length === 0) {
          // Auto-advance to next month silently — ready stays false until
          // the second fetch lands (no Apr→May flash).
          if (viewMonth === 11) {
            setViewYear((y) => y + 1);
            setViewMonth(0);
          } else {
            setViewMonth((m) => m + 1);
          }
        } else {
          setReady(true);
        }
      } else {
        setReady(true);
      }
    });
  }, [viewYear, viewMonth, fetchAvailability, checkedNoFuture, todayStr]);

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

  // Mega Tuesday + new juniors guard — same logic v1 page.tsx:2010-2016 uses.
  const hasNewJuniors = partyHasNewJuniors(session.party);
  const selectedIsTuesday = item.date ? isTuesdayISO(item.date) : false;
  const blockedForJuniors = selectedIsTuesday && hasNewJuniors;

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="font-display text-2xl uppercase tracking-widest text-white">Pick a Date</h3>
        <p className="mt-1 text-sm text-white/50">Choose when you&apos;d like to race.</p>
      </div>

      {!ready && (
        <div className="flex h-48 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
        </div>
      )}

      <div className="mx-auto max-w-sm" style={{ display: ready ? undefined : "none" }}>
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
              const isMega = megaDates.has(iso);
              const isSelected = item.date === iso;
              const isToday = iso === todayStr;
              // Morning-only buyout dates stay clickable (booking reopens midday);
              // the heat picker disables the pre-reopen heats. Only true full-day
              // buyouts grey the cell out.
              const groupEvent = getPublicReopenTimeForDate(iso) ? null : getGroupEventForDate(iso);

              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => isAvailable && !isPast && !groupEvent && onChange({ date: iso })}
                  disabled={!isAvailable || isPast || !!groupEvent}
                  title={groupEvent ? `Private Event: ${groupEvent.companyName}` : undefined}
                  className={
                    "aspect-square rounded-lg text-sm font-medium transition-all duration-150 " +
                    (groupEvent
                      ? "cursor-not-allowed bg-amber-500/15 text-amber-400/60 ring-1 ring-amber-500/30"
                      : isSelected
                        ? isMega
                          ? "bg-[#A855F7] font-bold text-white shadow-lg shadow-[#A855F7]/30"
                          : "bg-[#00E2E5] font-bold text-[#000418] shadow-lg shadow-[#00E2E5]/30"
                        : isAvailable && !isPast
                          ? isMega
                            ? "cursor-pointer bg-[#A855F7]/20 text-[#C084FC] hover:bg-[#A855F7]/35"
                            : "cursor-pointer bg-[#00E2E5]/15 text-[#00E2E5] hover:bg-[#00E2E5]/30"
                          : "cursor-not-allowed text-white/8") +
                    (isToday && !isSelected && !groupEvent ? " ring-1 ring-white/30" : "")
                  }
                >
                  {day}
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[13px] text-white/40">
          <div className="flex items-center gap-1.5">
            <div className="h-3 w-3 rounded bg-[#00E2E5]/15" />
            <span>Available</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-3 w-3 rounded bg-[#A855F7]/20 ring-1 ring-[#A855F7]/50" />
            <span>Mega Track</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-3 w-3 rounded bg-amber-500/15 ring-1 ring-amber-500/30" />
            <span>Private Event</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-3 w-3 rounded bg-white/5" />
            <span>Unavailable</span>
          </div>
        </div>

        {megaDates.size > 0 && (
          <div className="mt-3 rounded-xl border border-[#A855F7]/20 bg-[#A855F7]/5 p-3 text-center">
            <p className="mb-0.5 text-xs font-semibold text-[#C084FC]">Mega Track Tuesdays</p>
            <p className="text-[13px] leading-relaxed text-white/40">
              Blue &amp; Red tracks combine into one massive circuit!
            </p>
          </div>
        )}

        {availableDates.size === 0 && !loading && !error && (
          <p className="mt-4 text-center text-sm text-white/40">
            No available dates this month. Try the next month.
          </p>
        )}
      </div>

      {/* Mega Tuesday + new juniors banner — mirrors v1 page.tsx:2021-2068.
          Renders below the calendar; canAdvance blocks Next until the
          customer picks a different date or changes their party. */}
      {blockedForJuniors && (
        <div className="rounded-xl border-2 border-amber-400/50 bg-amber-400/10 p-5">
          <div className="flex items-start gap-3">
            <svg
              className="mt-0.5 h-6 w-6 shrink-0 text-amber-400"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
              />
            </svg>
            <div className="flex-1">
              <p className="mb-1 text-sm font-bold tracking-wider text-amber-400 uppercase">
                Heads up — Mega Tuesday
              </p>
              <p className="mb-3 text-sm leading-relaxed text-white/80">
                Tuesdays run on the Mega Track only, and first-time Junior races aren&apos;t offered
                on Mega. Your{" "}
                {countNewJuniors(session.party) === 1
                  ? "junior racer"
                  : `${countNewJuniors(session.party)} junior racers`}{" "}
                won&apos;t have a race to book on this date.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={() => onChange({ date: null })}
                  className="font-body flex-1 cursor-pointer rounded-lg bg-amber-400 px-4 py-2.5 text-sm font-bold tracking-wider text-[#010A20] uppercase transition-colors hover:bg-amber-300"
                >
                  Pick a different date
                </button>
                {/* v1 has a "Change party" CTA that jumps back to the party step.
                    v2's wizard nav owns step movement; surfacing a top-level
                    breadcrumb click is the v2 equivalent. The Back button at
                    the wizard footer handles the same intent. */}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function countNewJuniors(party: PartyMember[]): number {
  return party.filter((m) => (m.category ?? "adult") === "junior" && m.isNewRacer).length;
}

export const RaceDateStep: StepDef<RaceItem> = {
  id: "race-date",
  title: "Date",
  Component: RaceDateStepComponent,
  isVisible: () => true,
  canAdvance: (item, session) => {
    if (!item.date) return { reason: "Pick a race day to continue." };
    if (isTuesdayISO(item.date) && partyHasNewJuniors(session.party)) {
      return { reason: "First-time juniors can’t race on Mega Tuesdays." };
    }
    return true;
  },
};
