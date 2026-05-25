"use client";

import { useEffect, useState } from "react";
import type { PartyMember } from "~/features/booking";
import { modalBackdropProps } from "@/lib/a11y";

/**
 * RacerSelectorModal — pick which returning racers go in a single heat.
 *
 * Mirrors v1 `app/book/race/components/RacerSelector.tsx`. Triggered from
 * RaceHeatPickerStep when the customer clicks a time block AND at least
 * one party member in the current category has a `bmiPersonId` (verified
 * returning racer). New racers without a personId always book as a group
 * (no modal).
 *
 * Per-racer tier qualification + Race Pack credit balance display from
 * v1 are intentionally omitted here — they depend on Pandora data that
 * v2's returning-racer verification flow doesn't surface yet. The plumbing
 * lands when that follow-up PR adds the lookup.
 */

interface Props {
  /** Verified returning racers eligible to be picked. Filtered to the
   *  current booking category (adult / junior) by the parent. */
  racers: PartyMember[];
  /** PartyMember ids already on this heat (greyed + unselectable). */
  alreadyBookedMemberIds?: string[];
  onConfirm: (selectedRacers: PartyMember[]) => void;
  onCancel: () => void;
}

export function RacerSelectorModal({
  racers,
  alreadyBookedMemberIds = [],
  onConfirm,
  onCancel,
}: Props) {
  // Default: all not-yet-booked racers preselected — v1 default.
  const [selected, setSelected] = useState<Set<string>>(() => {
    const next = new Set<string>();
    for (const r of racers) {
      if (!alreadyBookedMemberIds.includes(r.id)) next.add(r.id);
    }
    return next;
  });

  // ESC closes — v1 a11y pattern.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  function toggle(memberId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  }

  function selectAll() {
    const next = new Set<string>();
    for (const r of racers) {
      if (!alreadyBookedMemberIds.includes(r.id)) next.add(r.id);
    }
    setSelected(next);
  }

  const selectedRacers = racers.filter((r) => selected.has(r.id));
  const eligibleCount = racers.filter((r) => !alreadyBookedMemberIds.includes(r.id)).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      {...modalBackdropProps(onCancel)}
      role="dialog"
      aria-modal="true"
      aria-label="Select racers for this heat"
    >
      <div className="max-h-[85vh] w-full max-w-md space-y-3 overflow-y-auto rounded-2xl border border-white/10 bg-[#000418] p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-display text-lg uppercase tracking-wider text-white">
              Who&apos;s Racing?
            </h3>
            <p className="text-xs text-white/40">Select racers for this heat</p>
          </div>
          {eligibleCount > 1 && (
            <button
              type="button"
              onClick={selectAll}
              className="text-xs font-semibold text-[#00E2E5] transition-colors hover:text-white"
            >
              Select All
            </button>
          )}
        </div>

        <div className="space-y-2">
          {racers.map((r) => {
            const alreadyBooked = alreadyBookedMemberIds.includes(r.id);
            const disabled = alreadyBooked;
            const checked = selected.has(r.id);
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => !disabled && toggle(r.id)}
                disabled={disabled}
                className={[
                  "flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors",
                  disabled
                    ? "cursor-not-allowed border-white/5 bg-white/[0.02] opacity-50"
                    : checked
                      ? "border-[#00E2E5]/40 bg-[#00E2E5]/5"
                      : "border-white/10 bg-white/5 hover:border-white/20",
                ].join(" ")}
              >
                <div
                  className={[
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors",
                    disabled
                      ? "border-white/10"
                      : checked
                        ? "border-[#00E2E5] bg-[#00E2E5]"
                        : "border-white/30",
                  ].join(" ")}
                >
                  {checked && !disabled && (
                    <svg
                      className="h-3 w-3 text-[#000418]"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-white">
                    {r.firstName}
                    {r.lastName ? ` ${r.lastName}` : ""}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2">
                    {alreadyBooked && (
                      <span className="text-xs text-white/30">Already on this heat</span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl border border-white/15 py-3 text-sm font-semibold text-white/50 transition-colors hover:border-white/30 hover:text-white/70"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => onConfirm(selectedRacers)}
            disabled={selectedRacers.length === 0}
            className="flex-1 rounded-xl bg-[#00E2E5] py-3 text-sm font-bold text-[#000418] shadow-lg shadow-[#00E2E5]/25 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-30"
          >
            Add {selectedRacers.length} Racer{selectedRacers.length !== 1 ? "s" : ""} to Heat
          </button>
        </div>
      </div>
    </div>
  );
}
