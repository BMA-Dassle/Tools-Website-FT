"use client";

/**
 * v3 bowling DATE step — calendar only (single-time-pick flow, 2026-07-19).
 *
 * The classic BowlingSlotsStep asked for date + an HOUR here, forcing a
 * second time pick after the availability search. In the v3 flow the time is
 * chosen exactly once, on the Time step, from genuinely bookable slots — so
 * this step is just the calendar (+ the "also booked this day" panel and the
 * cart-date inherit). Hidden on kiosks (walk-up = today, stamped at item
 * creation).
 */

import { useEffect, useMemo, useState } from "react";
import type { BowlingItem, KbfItem, StepDef } from "~/features/booking";
import {
  addDays,
  effectiveToday,
  otherActivitiesOnDate,
  todayYmd,
  CENTERS,
} from "~/features/booking/service/bowling-hours";
import { releaseBowlingHold } from "~/features/booking/service/bowling-offer";

// Bowling wizard accent — owner 2026-07-19: bowling reads BLUE ("red just
// seems negative"); FastTrax red stays on racing only. VIP keeps gold.
const BLUE = "#00E2E5";
const CYAN = "#00E2E5";

type BowlingLikeItem = BowlingItem | KbfItem;

const BowlingDateStepComponent: StepDef<BowlingLikeItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
}) => {
  const centerId = item.qamfCenterId ?? 9172;
  const center = CENTERS[centerId] ?? CENTERS[9172];

  const earliest = effectiveToday();
  const maxDate = addDays(todayYmd(), 30);

  // Is there a date on another cart item we can inherit?
  const cartDate = session.items.reduce<string | null>((found, other) => {
    if (found) return found;
    if (other.id === item.id) return null;
    const d = "date" in other ? (other as { date?: string | null }).date : null;
    return d && d >= earliest && d <= maxDate ? d : null;
  }, null);

  const [showCalendar, setShowCalendar] = useState(!cartDate);

  const selectedDate = item.date ?? "";

  const otherActivities = useMemo(
    () => (selectedDate ? otherActivitiesOnDate(session, item.id, selectedDate) : []),
    [session, item.id, selectedDate],
  );

  // Auto-select date from other cart items if this is a new item with no date
  useEffect(() => {
    if (item.date) return;
    if (cartDate) {
      onChange({ date: cartDate } as Partial<BowlingLikeItem>);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (dateStr === item.date) return;
    // A date change invalidates any live hold + picked time — release the
    // hold now rather than leaking it for its 10-min TTL.
    if (item.qamfReservationId) {
      void releaseBowlingHold(item.qamfCenterId ?? centerId, item.qamfReservationId);
      dispatch({ type: "clearBowlingHold", itemId: item.id });
    }
    onChange({
      date: dateStr,
      hour: null,
      minute: null,
      bookedAt: null,
      lineItems: [],
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

      {/* Already-booked activities this day — plan bowling around them */}
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
                <span className="text-white/85">{a.label}</span>
                <span className="font-semibold text-white">{a.timeLabel}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-center text-[11px] text-white/40">
            We&apos;ll flag bowling times that overlap these.
          </p>
        </div>
      )}

      <p className="text-center text-[11px] text-white/35">
        Pick your package next — then choose from real open lane times.
      </p>
    </div>
  );
};

const BowlingDateStep: StepDef<BowlingItem> = {
  id: "bowling-date",
  title: "Date",
  Component: BowlingDateStepComponent as StepDef<BowlingItem>["Component"],
  // Kiosk is walk-up/today-only — the date is stamped at item creation.
  isVisible: (_item, session) => !session.context?.kiosk,
  canAdvance: (item) => (!item.date ? { reason: "Pick a date" } : true),
};

export default BowlingDateStep;
