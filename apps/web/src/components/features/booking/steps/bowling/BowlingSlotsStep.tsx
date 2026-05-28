"use client";

import { useRef, useState } from "react";
import type { BowlingItem, KbfItem, StepDef } from "~/features/booking";

const CORAL = "#fd5b56";
const GOLD = "#FFD700";

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

function formatHour(h: number): string {
  const h24 = h % 24;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const hr = h24 % 12 || 12;
  return `${hr} ${ampm}`;
}

function formatHourMinute(h: number, m: number): string {
  const h24 = h % 24;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const hr = h24 % 12 || 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
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

const BowlingSlotsStepComponent: StepDef<BowlingLikeItem>["Component"] = ({ item, onChange }) => {
  const centerId = item.qamfCenterId ?? 9172;
  const center = CENTERS[centerId] ?? CENTERS[9172];

  const earliest = effectiveToday();
  const maxDate = addDays(todayYmd(), 30);

  const [calMonth, setCalMonth] = useState(() => {
    const d = item.date ? new Date(`${item.date}T12:00:00`) : new Date();
    return d.getMonth();
  });
  const [calYear, setCalYear] = useState(() => {
    const d = item.date ? new Date(`${item.date}T12:00:00`) : new Date();
    return d.getFullYear();
  });

  const hoursRef = useRef<HTMLDivElement>(null);
  const minutesRef = useRef<HTMLDivElement>(null);

  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const monthName = new Date(calYear, calMonth).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });

  function isBookableDate(dateStr: string): boolean {
    return dateStr >= earliest && dateStr <= maxDate;
  }

  function getHoursSync(dateStr: string): number[] {
    const dow = new Date(`${dateStr}T12:00:00`).getDay();
    const isWeekend = dow === 5 || dow === 6;
    const range = isWeekend ? { open: 11, close: 26 } : { open: 11, close: 24 };
    let hours = Array.from({ length: range.close - range.open }, (_, i) => i + range.open);
    const td = todayYmd();
    const nm = etNowMinutes();
    if (dateStr === td) {
      hours = hours.filter((h) => h * 60 + 45 >= nm + 15);
    }
    return hours;
  }

  const selectedDate = item.date ?? "";
  const selectedHour = item.hour;
  const selectedMinute = item.minute;
  const filteredHours = selectedDate ? getHoursSync(selectedDate) : [];

  function selectDate(dateStr: string) {
    onChange({
      date: dateStr,
      hour: null,
      minute: null,
      bookedAt: null,
    } as Partial<BowlingLikeItem>);
    setTimeout(
      () => hoursRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }),
      100,
    );
  }

  function selectHour(h: number) {
    onChange({ hour: h, minute: null, bookedAt: null } as Partial<BowlingLikeItem>);
    setTimeout(
      () => minutesRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }),
      100,
    );
  }

  function selectMinute(m: number) {
    onChange({ minute: m } as Partial<BowlingLikeItem>);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
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
        {selectedHour !== null && selectedMinute !== null && (
          <>
            <span className="text-white/20">&middot;</span>
            <span style={{ color: GOLD }}>{formatHourMinute(selectedHour, selectedMinute)}</span>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* Calendar */}
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

        {/* Hour + minute chips */}
        <div ref={hoursRef} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          {!selectedDate ? (
            <div className="flex min-h-[200px] items-center justify-center">
              <p className="text-sm text-white/30">Pick a date first</p>
            </div>
          ) : (
            <>
              <div className="mb-3 text-center text-xs uppercase tracking-[3px] text-white/35">
                Time
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {filteredHours.map((h) => {
                  const isActive = selectedHour === h;
                  return (
                    <button
                      key={h}
                      type="button"
                      onClick={() => selectHour(h)}
                      className="min-w-[60px] rounded-lg px-3 py-2 text-sm font-medium transition-all"
                      style={{
                        backgroundColor: isActive ? GOLD : "rgba(255,215,0,0.10)",
                        color: isActive ? "#0a1628" : GOLD,
                        fontWeight: isActive ? 800 : 500,
                      }}
                    >
                      {formatHour(h)}
                    </button>
                  );
                })}
              </div>

              {selectedHour !== null &&
                (() => {
                  const cutoff = (() => {
                    const td = todayYmd();
                    const nm = etNowMinutes();
                    if (selectedDate === td) return nm + 15;
                    if (selectedDate < td && nm < 120) return nm + 24 * 60 + 15;
                    return 0;
                  })();
                  const minutes = [0, 15, 30, 45].filter((m) => selectedHour * 60 + m >= cutoff);
                  return (
                    <div ref={minutesRef} className="mt-4 border-t border-white/8 pt-3">
                      <div className="mb-3 text-center text-xs uppercase tracking-[3px] text-white/35">
                        Select Time
                      </div>
                      <div className="flex flex-wrap justify-center gap-2">
                        {minutes.map((m) => {
                          const isActive = selectedMinute === m;
                          return (
                            <button
                              key={m}
                              type="button"
                              onClick={() => selectMinute(m)}
                              className="min-w-[90px] rounded-lg px-3 py-2 text-sm font-medium transition-all hover:scale-[1.02]"
                              style={{
                                backgroundColor: isActive ? GOLD : "rgba(255,215,0,0.10)",
                                color: isActive ? "#0a1628" : GOLD,
                                fontWeight: isActive ? 800 : 500,
                                boxShadow: isActive ? `0 0 12px ${GOLD}60` : undefined,
                              }}
                            >
                              {formatHourMinute(selectedHour, m)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const BowlingSlotsStep: StepDef<BowlingItem> = {
  id: "bowling-slots",
  title: "Date & Time",
  Component: BowlingSlotsStepComponent as StepDef<BowlingItem>["Component"],
  isVisible: () => true,
  canAdvance: (item) =>
    item.date && item.hour !== null && item.minute !== null
      ? true
      : { reason: "Pick a date and time" },
};

export default BowlingSlotsStep;
