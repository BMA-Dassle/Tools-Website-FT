"use client";

import { useEffect, useMemo, useState } from "react";
import type { PartyMember } from "~/features/booking";
import { tierFromMemberships, type RaceTier } from "~/features/booking/service/race-products";
import { modalBackdropProps } from "@/lib/a11y";

/**
 * RacerSelectorModal — pick which racers go in a single heat.
 *
 * Mirrors v1 `app/book/race/components/RacerSelector.tsx`. Triggered from
 * RaceHeatPickerStep when the customer clicks a time block AND at least
 * one party member in the current category has a `bmiPersonId` (verified
 * returning racer).
 *
 * Per-racer TIER QUALIFICATION (v1 parity): each racer's tier is derived
 * from their BMI memberships (new racers are always Starter). A racer below
 * the selected product's tier is shown CROSSED OUT — disabled, dimmed, with
 * a "Not qualified for {Tier}" note — rather than hidden, so the customer
 * understands why they can't add them to a Pro/Intermediate heat. Only
 * qualified, not-already-booked racers are preselected.
 */

/** Tier rank for comparison: starter < intermediate < pro. */
const TIER_RANK: Record<string, number> = { starter: 0, intermediate: 1, pro: 2 };
const rank = (t: string): number => TIER_RANK[t.toLowerCase()] ?? 0;

const TIER_BADGE_CLASS: Record<string, string> = {
  Pro: "bg-[#E53935]/15 text-[#E53935]",
  Intermediate: "bg-[#8652FF]/15 text-[#8652FF]",
  Starter: "bg-[#00E2E5]/15 text-[#00E2E5]",
};

/** A new racer is always Starter; returning racers derive tier from memberships. */
function racerTierOf(r: PartyMember): "Starter" | "Intermediate" | "Pro" {
  return r.isNewRacer ? "Starter" : tierFromMemberships(r.memberships ?? []);
}

interface Props {
  /** All party members in the current booking category (adult / junior).
   *  Includes new racers — they appear crossed out for non-Starter heats. */
  racers: PartyMember[];
  /** Tier of the selected product — gates per-racer qualification. */
  raceTier: RaceTier;
  /** PartyMember ids already on this heat (greyed + unselectable). */
  alreadyBookedMemberIds?: string[];
  onConfirm: (selectedRacers: PartyMember[]) => void;
  onCancel: () => void;
}

export function RacerSelectorModal({
  racers,
  raceTier,
  alreadyBookedMemberIds = [],
  onConfirm,
  onCancel,
}: Props) {
  const isQualified = (r: PartyMember): boolean => rank(racerTierOf(r)) >= rank(raceTier);
  const isPickable = (r: PartyMember): boolean =>
    isQualified(r) && !alreadyBookedMemberIds.includes(r.id);

  // Default: all qualified, not-yet-booked racers preselected — v1 default.
  const [selected, setSelected] = useState<Set<string>>(() => {
    const next = new Set<string>();
    for (const r of racers) {
      if (isPickable(r)) next.add(r.id);
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
      if (isPickable(r)) next.add(r.id);
    }
    setSelected(next);
  }

  const raceTierLabel = useMemo(
    () => raceTier.charAt(0).toUpperCase() + raceTier.slice(1),
    [raceTier],
  );

  const selectedRacers = racers.filter((r) => selected.has(r.id));
  const eligibleCount = racers.filter(isPickable).length;

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
            const qualified = isQualified(r);
            const disabled = alreadyBooked || !qualified;
            const checked = selected.has(r.id);
            const racerTier = racerTierOf(r);
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
                  <p
                    className={`truncate text-sm font-semibold ${
                      disabled && !alreadyBooked ? "text-white/50 line-through" : "text-white"
                    }`}
                  >
                    {r.firstName}
                    {r.lastName ? ` ${r.lastName}` : ""}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TIER_BADGE_CLASS[racerTier]}`}
                    >
                      {racerTier}
                    </span>
                    {!qualified && !alreadyBooked && (
                      <span className="text-xs font-medium text-[#E53935]/80">
                        Not qualified for {raceTierLabel}
                      </span>
                    )}
                    {alreadyBooked && (
                      <span className="text-xs text-white/30">Already on this heat</span>
                    )}
                  </div>
                  {r.creditBalances && r.creditBalances.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {r.creditBalances.map((cb) => (
                        <span
                          key={cb.kind}
                          className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-300/80"
                        >
                          {cb.balance} {cb.kind.replace(/^credit\s*-\s*/i, "").trim()}
                        </span>
                      ))}
                    </div>
                  )}
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
