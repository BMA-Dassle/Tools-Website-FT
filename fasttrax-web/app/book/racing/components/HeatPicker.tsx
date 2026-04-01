"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { RaceProduct, SmsProposal, SmsBlock } from "../data";

interface HeatPickerProps {
  race: RaceProduct;
  date: string; // YYYY-MM-DD
  quantity: number;
  onQuantityChange: (q: number) => void;
  onConfirm: (proposal: SmsProposal, block: SmsBlock) => void;
  onBack: () => void;
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function spotsLabel(free: number, capacity: number) {
  if (free === 0) return { text: "text-red-400", label: "Full" };
  if (free / capacity <= 0.3) return { text: "text-amber-400", label: `${free} spot${free === 1 ? "" : "s"} left` };
  return { text: "text-emerald-400", label: `${free} of ${capacity} open` };
}

export default function HeatPicker({ race, date, quantity, onQuantityChange, onConfirm, onBack }: HeatPickerProps) {
  const [proposals, setProposals] = useState<SmsProposal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const ctaRef = useRef<HTMLDivElement>(null);

  // Scroll to CTA when a heat is selected
  useEffect(() => {
    if (selectedIdx !== null) {
      setTimeout(() => {
        ctaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 50);
    }
  }, [selectedIdx]);

  const fetchSlots = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSelectedIdx(null);
    try {
      const res = await fetch("/api/sms?endpoint=dayplanner%2Fdayplanner", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productId: race.productId,
          pageId: race.pageId,
          quantity,
          dynamicLines: null,
          date: `${date}T00:00:00`,
        }),
      });
      if (!res.ok) throw new Error("Failed to fetch time slots");
      const data = await res.json();
      setProposals(data.proposals || []);
    } catch {
      setError("Couldn't load time slots. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [race.productId, race.pageId, date, quantity]);

  useEffect(() => { fetchSlots(); }, [fetchSlots]);

  const displayDate = new Date(date + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });

  const selectedProposal = selectedIdx !== null ? proposals[selectedIdx] : null;
  const selectedBlock = selectedProposal?.blocks?.[0]?.block ?? null;
  const total = selectedBlock ? (race.price * quantity).toFixed(2) : null;

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-1">Pick a Heat</h2>
        <p className="text-white/50 text-sm">
          <span className="text-white/80">{race.displayName}</span> · {displayDate}
        </p>
      </div>

      {/* Quantity picker */}
      <div className="max-w-sm mx-auto rounded-xl border border-white/10 bg-white/5 p-4">
        <p className="text-white/50 text-xs mb-3 text-center">How many racers?</p>
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => onQuantityChange(Math.max(1, quantity - 1))}
            className="w-10 h-10 rounded-full border border-white/20 text-white/70 hover:border-white/50 hover:text-white transition-all text-xl font-bold"
          >
            −
          </button>
          <span className="text-white text-2xl font-bold w-8 text-center">{quantity}</span>
          <button
            onClick={() => onQuantityChange(Math.min(10, quantity + 1))}
            className="w-10 h-10 rounded-full border border-white/20 text-white/70 hover:border-white/50 hover:text-white transition-all text-xl font-bold"
          >
            +
          </button>
        </div>
        <p className="text-white/30 text-xs text-center mt-2">Max 10 per online booking</p>
      </div>

      {loading ? (
        <div className="h-48 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-white/20 border-t-white/80 rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="h-48 flex flex-col items-center justify-center gap-3">
          <p className="text-red-400 text-sm">{error}</p>
          <button onClick={fetchSlots} className="text-xs text-white/50 hover:text-white underline">Retry</button>
        </div>
      ) : proposals.length === 0 ? (
        <div className="h-48 flex flex-col items-center justify-center gap-3">
          <p className="text-white/40 text-sm">No heats available for this date.</p>
          <button onClick={onBack} className="text-xs text-white/50 hover:text-white underline">← Choose a different date</button>
        </div>
      ) : (
        <>
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
                  onClick={() => !isFull && setSelectedIdx(idx)}
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

          {/* CTA */}
          <div ref={ctaRef} className={`rounded-xl border p-5 transition-all duration-300 ${selectedBlock ? "border-[#00E2E5]/40 bg-[#00E2E5]/8" : "border-white/10 bg-white/3"}`}>
            {selectedBlock ? (
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <p className="text-white/50 text-xs mb-1">Selected</p>
                  <p className="text-white font-bold">{selectedBlock.name} · {formatTime(selectedBlock.start)}</p>
                  <p className="text-[#00E2E5] text-sm font-semibold mt-0.5">
                    ${race.price.toFixed(2)} × {quantity} = <span className="text-lg">${total}</span>
                  </p>
                </div>
                <button
                  onClick={() => selectedProposal && selectedBlock && onConfirm(selectedProposal, selectedBlock)}
                  className="shrink-0 inline-flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25"
                >
                  Continue to Checkout →
                </button>
              </div>
            ) : (
              <p className="text-center text-white/30 text-sm">Select a heat above to continue</p>
            )}
          </div>

          {race.qualification && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-4">
              <p className="text-amber-400 text-xs font-semibold mb-1">Qualification Required</p>
              <p className="text-amber-300/70 text-xs leading-relaxed">{race.qualification}</p>
            </div>
          )}

          <div className="rounded-xl border border-white/8 bg-white/3 p-4 text-xs text-white/40 space-y-1">
            <p>· Arrive <strong className="text-white/60">30 minutes early</strong> for check-in.</p>
            <p>· A <strong className="text-white/60">$4.99 license fee</strong> per driver applies at first check-in.</p>
          </div>
        </>
      )}

      <button onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors">← Change date</button>
    </div>
  );
}
