"use client";

import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";

const coral = "#fd5b56";
const gold = "#FFD700";
const cyan = "#00E2E5";

function formatTimeStr(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

interface BowlingDateTimePickerProps {
  availableDates: Set<string>;
  selectedDate: string;
  onDateSelect: (date: string) => void;
  timeSlots: string[];
  selectedTime: string;
  onTimeSelect: (time: string) => void;
  onContinue: () => void;
  calMonth: number;
  calYear: number;
  onMonthChange: (month: number, year: number) => void;
  isToday: boolean;
}

export default function BowlingDateTimePicker({
  availableDates,
  selectedDate,
  onDateSelect,
  timeSlots,
  selectedTime,
  onTimeSelect,
  onContinue,
  calMonth,
  calYear,
  onMonthChange,
  isToday,
}: BowlingDateTimePickerProps) {
  // Group times by hour
  const hours = [...new Set(timeSlots.map(t => t.split(":")[0]))];
  const selectedHour = selectedTime ? selectedTime.split(":")[0] : "";
  const minutesForHour = selectedHour ? timeSlots.filter(t => t.startsWith(selectedHour + ":")) : [];

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  // Convert availableDates set to Date objects for react-day-picker
  const enabledDays = [...availableDates].map(d => new Date(d + "T12:00:00"));
  const selectedDayObj = selectedDate ? new Date(selectedDate + "T12:00:00") : undefined;

  return (
    <div>
      <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-4 text-center">
        When do you want to bowl?
      </h2>

      <div className="max-w-3xl mx-auto grid grid-cols-1 md:grid-cols-[auto_1fr] gap-6 items-start">
        {/* Calendar */}
        <div className="bowling-calendar">
          <DayPicker
            mode="single"
            selected={selectedDayObj}
            onSelect={(day) => {
              if (!day) return;
              const y = day.getFullYear();
              const m = String(day.getMonth() + 1).padStart(2, "0");
              const d = String(day.getDate()).padStart(2, "0");
              const dateStr = `${y}-${m}-${d}`;
              if (availableDates.has(dateStr)) {
                onDateSelect(dateStr);
              }
            }}
            month={new Date(calYear, calMonth)}
            onMonthChange={(month) => onMonthChange(month.getMonth(), month.getFullYear())}
            disabled={(date) => {
              const y = date.getFullYear();
              const m = String(date.getMonth() + 1).padStart(2, "0");
              const d = String(date.getDate()).padStart(2, "0");
              const dateStr = `${y}-${m}-${d}`;
              return !availableDates.has(dateStr) || dateStr < todayStr;
            }}
            showOutsideDays={false}
            fixedWeeks={false}
          />
        </div>

        {/* Time picker */}
        <div className="min-h-[280px] flex flex-col">
          {!selectedDate ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="font-[var(--font-hp-body)] text-white/30 text-sm">Pick a date to see times</p>
            </div>
          ) : timeSlots.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="font-[var(--font-hp-body)] text-white/40 text-sm text-center">
                {isToday ? "No more times available today." : "No times available."}
              </p>
            </div>
          ) : (
            <>
              <p className="font-[var(--font-hp-body)] text-white/30 text-[10px] uppercase tracking-widest mb-3 text-center">Hour</p>
              <div className="flex flex-wrap justify-center gap-2 mb-4">
                {hours.map(h => {
                  const hr = parseInt(h, 10);
                  const ampm = hr >= 12 ? "PM" : "AM";
                  const display = `${hr % 12 || 12} ${ampm}`;
                  const isActive = h === selectedHour;
                  return (
                    <button
                      key={h}
                      onClick={() => {
                        const firstSlot = timeSlots.find(t => t.startsWith(h + ":"));
                        if (firstSlot) onTimeSelect(firstSlot);
                      }}
                      className="rounded-lg px-4 py-2.5 text-sm font-[var(--font-hp-body)] font-bold transition-all cursor-pointer"
                      style={{
                        backgroundColor: isActive ? gold : "rgba(7,16,39,0.5)",
                        color: isActive ? "#0a1628" : "rgba(255,255,255,0.6)",
                        border: isActive ? `2px solid ${gold}` : "1px solid rgba(255,255,255,0.1)",
                      }}
                    >
                      {display}
                    </button>
                  );
                })}
              </div>

              {selectedHour && minutesForHour.length > 1 && (
                <>
                  <p className="font-[var(--font-hp-body)] text-white/30 text-[10px] uppercase tracking-widest mb-2 text-center">Minutes</p>
                  <div className="flex justify-center gap-2 mb-4">
                    {minutesForHour.map(t => {
                      const min = t.split(":")[1];
                      const isActive = t === selectedTime;
                      return (
                        <button
                          key={t}
                          onClick={() => onTimeSelect(t)}
                          className="rounded-lg px-5 py-2.5 text-sm font-[var(--font-hp-body)] font-bold transition-all cursor-pointer"
                          style={{
                            backgroundColor: isActive ? cyan : "rgba(7,16,39,0.5)",
                            color: isActive ? "#0a1628" : "rgba(255,255,255,0.6)",
                            border: isActive ? `2px solid ${cyan}` : "1px solid rgba(255,255,255,0.1)",
                          }}
                        >
                          :{min}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              {selectedTime && (
                <p className="font-[var(--font-hp-display)] text-center text-2xl mt-auto" style={{ color: gold }}>
                  {formatTimeStr(selectedTime)}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Continue button */}
      {selectedTime && (
        <div className="max-w-md mx-auto mt-6">
          <button
            onClick={onContinue}
            className="w-full py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
            style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}
          >
            See Available Packages
          </button>
        </div>
      )}

      {/* Dark theme overrides for react-day-picker */}
      <style>{`
        .bowling-calendar .rdp-root {
          --rdp-accent-color: ${cyan};
          --rdp-accent-background-color: ${cyan}20;
          --rdp-day-height: 40px;
          --rdp-day-width: 40px;
          --rdp-selected-font: bold;
          font-family: var(--font-hp-body);
          color: white;
        }
        .bowling-calendar .rdp-month_caption {
          font-family: var(--font-hp-body);
          font-weight: 700;
          font-size: 14px;
          color: white;
          padding: 0 8px;
        }
        .bowling-calendar .rdp-weekday {
          color: rgba(255,255,255,0.3);
          font-size: 11px;
        }
        .bowling-calendar .rdp-day button {
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          transition: all 0.15s;
        }
        .bowling-calendar .rdp-day:not(.rdp-disabled) button {
          color: ${cyan};
          background: ${cyan}15;
        }
        .bowling-calendar .rdp-day:not(.rdp-disabled) button:hover {
          background: ${cyan}30;
        }
        .bowling-calendar .rdp-selected .rdp-day_button {
          background: ${cyan} !important;
          color: #000418 !important;
          font-weight: 700;
          box-shadow: 0 0 12px ${cyan}30;
        }
        .bowling-calendar .rdp-disabled button {
          color: rgba(255,255,255,0.15) !important;
          cursor: not-allowed;
        }
        .bowling-calendar .rdp-today:not(.rdp-selected) .rdp-day_button {
          outline: 1px solid rgba(255,255,255,0.2);
        }
        .bowling-calendar .rdp-button_previous,
        .bowling-calendar .rdp-button_next {
          color: rgba(255,255,255,0.5);
          border: none;
          background: none;
          cursor: pointer;
          padding: 6px;
          border-radius: 8px;
        }
        .bowling-calendar .rdp-button_previous:hover,
        .bowling-calendar .rdp-button_next:hover {
          color: white;
          background: rgba(255,255,255,0.1);
        }
        .bowling-calendar .rdp-chevron {
          fill: currentColor;
        }
      `}</style>
    </div>
  );
}
