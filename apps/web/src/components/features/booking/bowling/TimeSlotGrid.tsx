"use client";

/**
 * Full-day time-slot grid under the Next-Available hero ("Or pick another
 * time"), grouped Morning / Afternoon / Evening / Late Night in the 0-26h ET
 * notation so 12:30 AM Saturday sorts after 11 PM Friday. Every slot passed
 * in is genuinely bookable (the accurate availability mode guarantees it) —
 * tapping one is a commitment (the Time step holds it immediately).
 *
 * Conflict posture differs by surface: web renders an advisory ring +
 * tooltip (pick still allowed); kiosk hard-disables with strike-through.
 */

import { etHour } from "~/components/features/booking/steps/bowling/availability-client";

export interface GridSlot {
  bookedAt: string;
  label: string;
}

export interface TimeSlotGridProps {
  variant: "web" | "kiosk";
  slots: GridSlot[];
  selectedAt: string | null;
  /** bookedAt currently being held — shows the inline spinner on that pill. */
  reservingAt: string | null;
  accent: string;
  /** Label of the conflicting cart item at this time, or null when clear. */
  conflictOf: (bookedAt: string) => string | null;
  disabled?: boolean;
  onPick: (slot: GridSlot) => void;
}

const GROUPS: Array<{ label: string; match: (h: number) => boolean }> = [
  { label: "Morning", match: (h) => h < 12 },
  { label: "Afternoon", match: (h) => h >= 12 && h < 17 },
  { label: "Evening", match: (h) => h >= 17 && h < 24 },
  { label: "Late Night", match: (h) => h >= 24 },
];

export function TimeSlotGrid(props: TimeSlotGridProps) {
  const { variant, slots, selectedAt, reservingAt, accent, conflictOf, disabled, onPick } = props;
  const kiosk = variant === "kiosk";

  const grouped = GROUPS.map((g) => ({
    label: g.label,
    slots: slots.filter((s) => g.match(etHour(s.bookedAt))),
  })).filter((g) => g.slots.length > 0);

  return (
    <div className={kiosk ? "space-y-[28px]" : "space-y-5"}>
      {grouped.map((group) => (
        <div key={group.label}>
          <div
            className={
              kiosk
                ? "k-eyebrow mb-[16px] text-white/40"
                : "mb-2 text-[11px] uppercase tracking-[2px] text-white/35"
            }
          >
            {group.label}
          </div>
          <div className={kiosk ? "grid grid-cols-4 gap-[14px]" : "flex flex-wrap gap-2"}>
            {group.slots.map((slot) => {
              const conflict = conflictOf(slot.bookedAt);
              const isSelected = selectedAt === slot.bookedAt;
              const isReserving = reservingAt === slot.bookedAt;
              if (kiosk) {
                // Tap = live QAMF hold (1-3s) — the tapped pill must light up
                // and spin IMMEDIATELY or the tap reads as dead; siblings dim
                // so the one in flight is unmistakable (owner 2026-07-21).
                return (
                  <button
                    key={slot.bookedAt}
                    type="button"
                    onClick={() => onPick(slot)}
                    disabled={disabled || !!conflict}
                    title={conflict ?? undefined}
                    className={`k-chip k-tap ${isSelected || isReserving ? "sel" : ""} ${
                      conflict
                        ? "opacity-35 line-through"
                        : disabled && !isReserving
                          ? "opacity-40"
                          : ""
                    }`}
                  >
                    {isReserving && (
                      <span
                        className="h-[24px] w-[24px] animate-spin rounded-full border-[3px] border-current border-t-transparent"
                        aria-hidden
                      />
                    )}
                    {slot.label}
                  </button>
                );
              }
              return (
                <button
                  key={slot.bookedAt}
                  type="button"
                  onClick={() => onPick(slot)}
                  disabled={disabled}
                  title={conflict ? `You're also booked: ${conflict}` : undefined}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-all disabled:opacity-60"
                  style={{
                    backgroundColor: isSelected ? accent : `${accent}15`,
                    color: isSelected ? "#0a1628" : accent,
                    fontWeight: isSelected ? 800 : 500,
                    boxShadow: isSelected ? `0 0 12px ${accent}60` : undefined,
                    border: conflict ? `1px solid #f59e0b99` : "1px solid transparent",
                  }}
                >
                  {isReserving && (
                    <span
                      className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
                      aria-hidden
                    />
                  )}
                  {slot.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
