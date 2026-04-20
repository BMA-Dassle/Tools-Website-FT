"use client";

import { useState } from "react";
import type { PersonData } from "./ReturningRacerLookup";
import { getRacerTier } from "../data";
import { modalBackdropProps } from "@/lib/a11y";

/** Tier level for comparison: starter=0, intermediate=1, pro=2 */
function tierLevel(tier: string): number {
  if (tier === "pro" || tier === "Pro") return 2;
  if (tier === "intermediate" || tier === "Intermediate") return 1;
  return 0;
}

interface Props {
  racers: PersonData[];
  /** The tier of the selected product */
  raceTier: "starter" | "intermediate" | "pro";
  /** PersonIds already booked on this exact heat (greyed out) */
  alreadyBookedPersonIds?: string[];
  onConfirm: (selectedRacers: PersonData[]) => void;
  onCancel: () => void;
}

export default function RacerSelector({ racers, raceTier, alreadyBookedPersonIds = [], onConfirm, onCancel }: Props) {
  // Default: all eligible racers selected
  const [selected, setSelected] = useState<Set<string>>(() => {
    const eligible = new Set<string>();
    for (const r of racers) {
      const tier = getRacerTier(r.memberships || []);
      const qualified = tierLevel(tier) >= tierLevel(raceTier);
      const alreadyBooked = alreadyBookedPersonIds.includes(r.personId);
      if (qualified && !alreadyBooked) eligible.add(r.personId);
    }
    return eligible;
  });

  function toggleRacer(personId: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  }

  function selectAll() {
    const eligible = new Set<string>();
    for (const r of racers) {
      const tier = getRacerTier(r.memberships || []);
      if (tierLevel(tier) >= tierLevel(raceTier) && !alreadyBookedPersonIds.includes(r.personId)) {
        eligible.add(r.personId);
      }
    }
    setSelected(eligible);
  }

  const selectedRacers = racers.filter(r => selected.has(r.personId));
  const eligibleCount = racers.filter(r => {
    const tier = getRacerTier(r.memberships || []);
    return tierLevel(tier) >= tierLevel(raceTier) && !alreadyBookedPersonIds.includes(r.personId);
  }).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" {...modalBackdropProps(onCancel)}>
    <div className="max-w-md w-full rounded-2xl border border-white/10 bg-[#000418] p-6 space-y-3 shadow-2xl max-h-[85vh] overflow-y-auto">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-white font-display text-lg uppercase tracking-wider">Who&apos;s Racing?</h3>
          <p className="text-white/40 text-xs">Select racers for this heat</p>
        </div>
        {eligibleCount > 1 && (
          <button
            onClick={selectAll}
            className="text-[#00E2E5] text-xs font-semibold hover:text-white transition-colors"
          >
            Select All
          </button>
        )}
      </div>

      <div className="space-y-2">
        {racers.map(r => {
          const tier = getRacerTier(r.memberships || []);
          const qualified = tierLevel(tier) >= tierLevel(raceTier);
          const alreadyBooked = alreadyBookedPersonIds.includes(r.personId);
          const disabled = !qualified || alreadyBooked;
          const checked = selected.has(r.personId);

          return (
            <button
              key={r.personId}
              onClick={() => !disabled && toggleRacer(r.personId)}
              disabled={disabled}
              className={`w-full rounded-xl border p-4 flex items-center gap-3 transition-colors text-left ${
                disabled
                  ? "border-white/5 bg-white/[0.02] opacity-50 cursor-not-allowed"
                  : checked
                  ? "border-[#00E2E5]/40 bg-[#00E2E5]/5"
                  : "border-white/10 bg-white/5 hover:border-white/20"
              }`}
            >
              {/* Checkbox */}
              <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                disabled ? "border-white/10" : checked ? "border-[#00E2E5] bg-[#00E2E5]" : "border-white/30"
              }`}>
                {checked && !disabled && (
                  <svg className="w-3 h-3 text-[#000418]" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>

              {/* Racer info */}
              <div className="min-w-0 flex-1">
                <p className="text-white font-semibold text-sm truncate">{r.fullName}</p>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  {/* Tier badge */}
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                    tier === "Pro"
                      ? "bg-red-500/20 text-red-400"
                      : tier === "Intermediate"
                      ? "bg-blue-500/20 text-blue-400"
                      : "bg-green-500/20 text-green-400"
                  }`}>
                    {tier}
                  </span>

                  {/* Not qualified message */}
                  {!qualified && !alreadyBooked && (
                    <span className="text-xs text-red-400/70">
                      Not qualified for {raceTier.charAt(0).toUpperCase() + raceTier.slice(1)}
                    </span>
                  )}

                  {/* Already booked */}
                  {alreadyBooked && (
                    <span className="text-xs text-white/30">Already on this heat</span>
                  )}
                </div>

                {/* Credit balances */}
                {r.hasCredits && r.creditBalances && r.creditBalances.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {r.creditBalances.map((cb, i) => (
                      <span key={i} className="text-xs font-semibold px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-400/80">
                        {cb.kind}: {cb.balance}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <button
          onClick={onCancel}
          className="flex-1 py-3 rounded-xl border border-white/15 text-white/50 text-sm font-semibold hover:border-white/30 hover:text-white/70 transition-colors"
        >
          Back
        </button>
        <button
          onClick={() => onConfirm(selectedRacers)}
          disabled={selectedRacers.length === 0}
          className="flex-1 py-3 rounded-xl bg-[#00E2E5] text-[#000418] text-sm font-bold hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Add {selectedRacers.length} Racer{selectedRacers.length !== 1 ? "s" : ""} to Heat
        </button>
      </div>
    </div>
    </div>
  );
}
