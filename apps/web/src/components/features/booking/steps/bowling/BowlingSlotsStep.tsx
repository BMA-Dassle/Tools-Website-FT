"use client";

import { useEffect, useState } from "react";
import type { BowlingItem, KbfItem, StepDef } from "~/features/booking";
import { HP_LOCATIONS } from "@/lib/headpinz-locations";
import { DiscountCodeInput } from "./DiscountCodeInput";

const CORAL = "#fd5b56";

const CENTERS: Record<number, { hpSlug: string; name: string }> = {
  9172: { hpSlug: "fort-myers", name: "HeadPinz Fort Myers" },
  3148: { hpSlug: "naples", name: "HeadPinz Naples" },
};

function ymdFromDate(dt: Date): string {
  return dt.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function todayYmd(): string {
  return ymdFromDate(new Date());
}

function etNowMinutes(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    timeZone: "America/New_York",
  }).formatToParts(new Date());
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return h * 60 + m;
}

function effectiveToday(): string {
  const today = todayYmd();
  const nowMins = etNowMinutes();
  if (nowMins >= 120) return today;
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() - 1);
  const yesterday = ymdFromDate(d);
  const dow = new Date(`${yesterday}T12:00:00`).getDay();
  if (dow === 5 || dow === 6) return yesterday;
  return today;
}

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + n);
  return ymdFromDate(d);
}

function parseHourToken(token: string): number {
  const match = token.trim().match(/^(\d+)(AM|PM)$/i);
  if (!match) return 11;
  let h = parseInt(match[1], 10);
  const period = match[2].toUpperCase();
  if (period === "PM" && h !== 12) h += 12;
  else if (period === "AM" && h === 12) h = 24;
  else if (period === "AM" && h < 9) h += 24;
  return h;
}

function parseHoursRange(hoursStr: string): { open: number; close: number } {
  const timePart = hoursStr.split(" ").pop() ?? "11AM-2AM";
  const dash = timePart.lastIndexOf("-");
  return {
    open: parseHourToken(timePart.slice(0, dash)),
    close: parseHourToken(timePart.slice(dash + 1)),
  };
}

type BowlingLikeItem = BowlingItem | KbfItem;

/**
 * First bookable hour for a date — center open hour, minus hours already past
 * if the date is today, with the KBF Friday cap. Used to seed the availability
 * query on the Package step now that the calendar is date-only (the customer
 * picks the actual slot there).
 */
function firstBookableHour(centerHpSlug: string, dateStr: string, isKbf: boolean): number {
  const dow = new Date(`${dateStr}T12:00:00`).getDay();
  const isWeekend = dow === 5 || dow === 6;
  const loc = HP_LOCATIONS[centerHpSlug];
  const range = loc
    ? parseHoursRange(isWeekend ? loc.hoursWeekend : loc.hours)
    : isWeekend
      ? { open: 11, close: 26 }
      : { open: 11, close: 24 };
  let hours = Array.from({ length: range.close - range.open }, (_, i) => i + range.open);

  // KBF Friday: cap at 5 PM (v1 parity — BowlingWizard.tsx:1430)
  if (isKbf && dow === 5) hours = hours.filter((h) => h < 17);

  const td = todayYmd();
  const nm = etNowMinutes();
  if (dateStr === td) hours = hours.filter((h) => h * 60 + 45 >= nm + 15);

  return hours[0] ?? range.open;
}

const BowlingSlotsStepComponent: StepDef<BowlingLikeItem>["Component"] = ({
  item,
  session,
  onChange,
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

  // Auto-select date from other cart items if this is a new item with no date
  useEffect(() => {
    if (item.date) return;
    if (cartDate) {
      onChange({ date: cartDate } as Partial<BowlingLikeItem>);
    }
  }, []);

  // Date-only calendar: once a date is chosen (picked or inherited), seed a
  // start time for the Package step's availability query. The customer picks
  // the actual slot there — matching how attractions work.
  useEffect(() => {
    if (!item.date) return;
    if (item.hour !== null) return;
    onChange({
      hour: firstBookableHour(center.hpSlug, item.date, item.kind === "kbf"),
      minute: 0,
    } as Partial<BowlingLikeItem>);
  }, [item.date, item.hour]);

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

  const selectedDate = item.date ?? "";

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
        <span style={{ color: CORAL }}>{center.name}</span>
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

      {/* Discount code — bowling only (KBF is free) */}
      {item.kind === "bowling" && (
        <DiscountCodeInput
          locationId={centerId === 9172 ? "TXBSQN0FEKQ11" : "PPTR5G2N0QXF7"}
          appliedCode={(item as BowlingItem).discountCode}
          onApply={(discount) =>
            onChange({ discountCode: discount.code } as Partial<BowlingLikeItem>)
          }
          onClear={() => onChange({ discountCode: null } as Partial<BowlingLikeItem>)}
        />
      )}

      {/* Compact date confirmation when inherited from cart */}
      {!showCalendar ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-[#fd5b56]/20 bg-[#fd5b56]/5 p-5 text-center">
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
                      ? CORAL
                      : bookable
                        ? "rgba(253,91,86,0.15)"
                        : "transparent",
                    color: isSelected ? "#0a1628" : bookable ? CORAL : "rgba(255,255,255,0.18)",
                    fontWeight: isSelected ? 800 : 500,
                    cursor: bookable ? "pointer" : "not-allowed",
                    boxShadow: isSelected ? `0 0 14px ${CORAL}60` : undefined,
                  }}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {selectedDate && (
        <p className="text-center text-xs text-white/35">
          You&apos;ll choose your time on the next step.
        </p>
      )}
    </div>
  );
};

const BowlingSlotsStep: StepDef<BowlingItem> = {
  id: "bowling-slots",
  title: "Date",
  Component: BowlingSlotsStepComponent as StepDef<BowlingItem>["Component"],
  isVisible: () => true,
  canAdvance: (item) => (item.date ? true : { reason: "Pick a date" }),
};

export default BowlingSlotsStep;
