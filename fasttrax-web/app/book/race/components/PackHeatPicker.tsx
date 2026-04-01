"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type {
  ClassifiedProduct,
  BmiProposal,
  BmiBlock,
  BmiBookResponse,
  PackSchedule,
} from "../data";
import { bmiPost } from "../data";
import type { PackBookingResult } from "./OrderSummary";

// ── Props ────────────────────────────────────────────────────────────────────

interface PackHeatPickerProps {
  race: ClassifiedProduct;
  date: string; // YYYY-MM-DD
  quantity: number;
  onComplete: (result: PackBookingResult) => void;
  onBack: () => void;
}

// ── Shared sub-components ───────────────────────────────────────────────────

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function spotsLabel(free: number, capacity: number) {
  if (free === 0) return { text: "text-red-400", label: "Full" };
  if (free / capacity <= 0.3) return { text: "text-amber-400", label: `${free} spot${free === 1 ? "" : "s"} left` };
  return { text: "text-emerald-400", label: `${free} of ${capacity} open` };
}

function HeatGrid({
  proposals,
  selectedIdx,
  onSelect,
  quantity,
}: {
  proposals: BmiProposal[];
  selectedIdx: number | null;
  onSelect: (idx: number) => void;
  quantity: number;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
      {proposals.map((proposal, idx) => {
        const block = proposal.blocks?.[0]?.block;
        if (!block) return null;
        const isFull = block.freeSpots < quantity;
        const isSelected = selectedIdx === idx;
        const spots = spotsLabel(block.freeSpots, block.capacity);

        return (
          <button
            key={idx}
            onClick={() => !isFull && onSelect(idx)}
            disabled={isFull}
            className={`
              rounded-xl border p-3 text-left transition-all duration-150
              ${isSelected
                ? "border-[#00E2E5] bg-[#00E2E5]/15 ring-1 ring-[#00E2E5]/50"
                : isFull
                  ? "border-white/5 bg-white/3 opacity-40 cursor-not-allowed"
                  : "border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10 cursor-pointer"
              }
            `}
          >
            <div className="text-white font-bold text-base mb-0.5">{formatTime(block.start)}</div>
            <div className="text-white/40 text-xs mb-2">→ {formatTime(block.stop)}</div>
            <div className="text-xs font-medium mb-1 text-white/60">{block.name}</div>
            <div className={`text-[11px] font-medium ${isFull ? "text-red-400" : spots.text}`}>
              {isFull ? `Need ${quantity}, only ${block.freeSpots} left` : spots.label}
            </div>
            <div className="mt-2 h-1 rounded-full bg-white/10 overflow-hidden">
              <div
                className={`h-full rounded-full ${isFull ? "bg-red-500" : block.freeSpots / block.capacity <= 0.3 ? "bg-amber-400" : "bg-emerald-400"}`}
                style={{ width: `${(block.freeSpots / block.capacity) * 100}%` }}
              />
            </div>
          </button>
        );
      })}
    </div>
  );
}

function SelectedHeats({ schedules }: { schedules: PackSchedule[] }) {
  if (schedules.length === 0) return null;
  return (
    <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-4">
      <p className="text-green-400 text-xs font-semibold uppercase tracking-wider mb-2">Heats Selected</p>
      {schedules.map((s, i) => (
        <div key={i} className="flex justify-between text-sm text-white/70">
          <span>Race {i + 1}{s.trackName ? ` — ${s.trackName} Track` : ""}</span>
          <span className="text-white/40">{formatTime(s.start)}</span>
        </div>
      ))}
    </div>
  );
}

function ProgressDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`w-2.5 h-2.5 rounded-full transition-colors ${
            i < current ? "bg-green-400" : i === current ? "bg-[#00E2E5] ring-2 ring-[#00E2E5]/30" : "bg-white/15"
          }`}
        />
      ))}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function PackHeatPicker({ race, date, quantity, onComplete, onBack }: PackHeatPickerProps) {
  if (race.packType === "combo") {
    return <ComboPackPicker race={race} date={date} quantity={quantity} onComplete={onComplete} onBack={onBack} />;
  }
  // Sell packs (Red/Blue weekday) are not yet supported via BMI API
  return <SellPackNotSupported race={race} onBack={onBack} />;
}

// ── Sell Pack — Not Yet Supported ───────────────────────────────────────────

function SellPackNotSupported({ race, onBack }: { race: ClassifiedProduct; onBack: () => void }) {
  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-1">Weekday Packs</h2>
        <p className="text-white/50 text-sm">{race.name}</p>
      </div>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-6 text-center space-y-3">
        <p className="text-amber-400 font-semibold text-sm">Coming Soon</p>
        <p className="text-amber-300/70 text-sm leading-relaxed">
          Online booking for weekday packs is not yet available. Please call us or visit the front desk to book a weekday pack.
        </p>
        <p className="text-white/40 text-xs">
          Call <a href="tel:+18133403687" className="text-[#00E2E5] hover:underline">(813) 340-3687</a> for assistance.
        </p>
      </div>

      <button onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors">&larr; Choose a different race</button>
    </div>
  );
}

// ── Combo Pack Picker (Mega track) ──────────────────────────────────────────

function ComboPackPicker({ race, date, quantity, onComplete, onBack }: PackHeatPickerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<BmiProposal[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Multi-step state
  const [currentRace, setCurrentRace] = useState(0); // 0-indexed
  const totalRaces = race.raceCount;
  const [schedules, setSchedules] = useState<PackSchedule[]>([]);
  const [orderId, setOrderId] = useState<number | null>(null);
  const ctaRef = useRef<HTMLDivElement>(null);

  // Scroll to CTA on selection
  useEffect(() => {
    if (selectedIdx !== null) {
      setTimeout(() => ctaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
  }, [selectedIdx]);

  // Fetch heats from BMI availability endpoint
  const fetchHeats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await bmiPost(
        "availability",
        { productId: race.productId, quantity },
        { date },
      );
      setProposals(res.proposals || []);
    } catch {
      setError("Couldn't load time slots. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [race.productId, date, quantity]);

  // Fetch initial heats on mount
  useEffect(() => { fetchHeats(); }, [fetchHeats]);

  async function handleConfirmHeat() {
    if (selectedIdx === null) return;
    setConfirming(true);
    setError(null);

    const proposal = proposals[selectedIdx];
    const block = proposal.blocks?.[0]?.block;
    if (!block) return;

    try {
      const payload: Record<string, unknown> = {
        productId: race.productId,
        quantity,
        resourceId: String(block.resourceId),
        proposal: {
          blocks: proposal.blocks.map(pb => ({
            productLineIds: pb.productLineIds || [],
            block: pb.block,
          })),
          productLineId: proposal.productLineId ?? null,
        },
      };

      // Include orderId for subsequent heats (2nd, 3rd, etc.)
      if (orderId !== null) {
        payload.orderId = orderId;
      }

      const result: BmiBookResponse = await bmiPost("booking/book", payload);

      // Capture orderId from first booking
      const newOrderId = result.orderId ?? orderId;
      if (newOrderId !== null) setOrderId(newOrderId);

      // Record this schedule
      const newSchedule: PackSchedule = {
        start: block.start,
        stop: block.stop,
        name: block.name,
      };
      const updatedSchedules = [...schedules, newSchedule];
      setSchedules(updatedSchedules);

      const nextRace = currentRace + 1;

      if (nextRace < totalRaces) {
        // More races to pick -- fetch updated availability
        // BMI API does not return nextProposals; we call availability again
        // which will automatically exclude already-booked heats
        setCurrentRace(nextRace);
        setSelectedIdx(null);
        setLoading(true);
        try {
          const availRes = await bmiPost(
            "availability",
            { productId: race.productId, quantity },
            { date },
          );
          setProposals(availRes.proposals || []);
        } catch {
          setError("Couldn't load time slots for the next race.");
        } finally {
          setLoading(false);
        }
      } else {
        // All races booked -- use schedules from response if available, otherwise our local ones
        const finalSchedules = result.schedules?.length
          ? result.schedules.map(s => ({ start: s.start, stop: "", name: s.name }))
          : updatedSchedules;
        onComplete({ billId: String(newOrderId), schedules: finalSchedules });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to book heat");
    } finally {
      setConfirming(false);
    }
  }

  const displayDate = new Date(date + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-1">Pick Your Heats</h2>
        <p className="text-white/50 text-sm">
          <span className="text-white/80">{race.name}</span> · {displayDate}
        </p>
        <p className="text-[#00E2E5] text-sm font-semibold mt-1">
          Race {currentRace + 1} of {totalRaces}
        </p>
      </div>

      <ProgressDots current={currentRace} total={totalRaces} />
      <SelectedHeats schedules={schedules} />

      {loading ? (
        <div className="h-48 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-white/20 border-t-white/80 rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="h-48 flex flex-col items-center justify-center gap-3">
          <p className="text-red-400 text-sm">{error}</p>
          {currentRace === 0 && (
            <button onClick={fetchHeats} className="text-xs text-white/50 hover:text-white underline">Retry</button>
          )}
        </div>
      ) : proposals.length === 0 ? (
        <div className="h-48 flex flex-col items-center justify-center gap-3">
          <p className="text-white/40 text-sm">No heats available.</p>
        </div>
      ) : (
        <>
          <HeatGrid proposals={proposals} selectedIdx={selectedIdx} onSelect={setSelectedIdx} quantity={quantity} />

          <div ref={ctaRef} className={`rounded-xl border p-5 transition-all duration-300 ${selectedIdx !== null ? "border-[#00E2E5]/40 bg-[#00E2E5]/8" : "border-white/10 bg-white/3"}`}>
            {selectedIdx !== null ? (
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <p className="text-white/50 text-xs mb-1">Race {currentRace + 1} of {totalRaces}</p>
                  <p className="text-white font-bold">
                    {proposals[selectedIdx].blocks?.[0]?.block.name} · {formatTime(proposals[selectedIdx].blocks?.[0]?.block.start)}
                  </p>
                  {currentRace === 0 && (
                    <p className="text-[#00E2E5] text-sm font-semibold mt-0.5">
                      ${race.price.toFixed(2)} for {totalRaces} races
                    </p>
                  )}
                </div>
                <button
                  onClick={handleConfirmHeat}
                  disabled={confirming}
                  className="shrink-0 inline-flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25 disabled:opacity-50"
                >
                  {confirming ? (
                    <div className="w-4 h-4 border-2 border-[#000418]/30 border-t-[#000418] rounded-full animate-spin" />
                  ) : currentRace < totalRaces - 1 ? (
                    `Confirm & Pick Race ${currentRace + 2} →`
                  ) : (
                    "Confirm & Continue to Checkout →"
                  )}
                </button>
              </div>
            ) : (
              <p className="text-center text-white/30 text-sm">Select a heat for race {currentRace + 1} above</p>
            )}
          </div>
        </>
      )}

      {race.raw.message && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-4">
          <p className="text-amber-400 text-xs font-semibold mb-1">Qualification Required</p>
          <p className="text-amber-300/70 text-xs leading-relaxed">{race.raw.message}</p>
        </div>
      )}

      <div className="rounded-xl border border-white/8 bg-white/3 p-4 text-xs text-white/40 space-y-1">
        <p>· Arrive <strong className="text-white/60">30 minutes early</strong> for check-in.</p>
        <p>· A <strong className="text-white/60">$4.99 license fee</strong> per driver applies at first check-in.</p>
      </div>

      <button onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors">&larr; Change race</button>
    </div>
  );
}
