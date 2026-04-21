"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type {
  ClassifiedProduct,
  SmsProposal,
  SmsBlock,
  SmsBookResponse,
  SmsSellResponse,
  SmsModifierPage,
  SmsProduct,
  PackSchedule,
} from "../data";
import { heatsConflict, HEAT_CONFLICT_TOOLTIP } from "@/lib/heat-conflict";

/**
 * Attach a policy memo to the pack bill so ops staff see it in BMI
 * Office and on reservation screens. Best-effort; a memo failure must
 * not break the booking handoff.
 *
 * For single-racer packs (the common case) nothing overwrites this
 * memo later — the group memo in OrderSummary only fires when
 * `bills.length > 1`.
 */
async function attachPackMemo(billId: string, race: ClassifiedProduct) {
  try {
    const memo =
      `** 3-RACE PACK PURCHASE (${race.name}) ** ` +
      `All 3 heats are tied to ONE racer — DO NOT split between different racers. ` +
      `No cash refunds — credits only if rescheduling is required.`;
    const qs = new URLSearchParams({ endpoint: "booking/memo" });
    const body = `{"orderId":${billId},"memo":"${memo.replace(/"/g, '\\"')}"}`;
    const res = await fetch(`/api/bmi?${qs.toString()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    console.log("[pack memo]", billId, "status:", res.status);
  } catch (err) {
    console.warn("[pack memo] failed (non-fatal):", err);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** Result passed to parent when all races are booked */
export interface PackBookingResult {
  billId: string;
  schedules: PackSchedule[];
}

interface PackHeatPickerProps {
  race: ClassifiedProduct;
  date: string; // YYYY-MM-DD
  quantity: number;
  onComplete: (result: PackBookingResult) => void;
  onBack: () => void;
}

// ── Shared sub-components ─────────────────────────────────────────────────────

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
  proposals: SmsProposal[];
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
            <div className={`text-[13px] font-medium ${isFull ? "text-red-400" : spots.text}`}>
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

// ── API helper ────────────────────────────────────────────────────────────────

async function sms(endpoint: string, body: unknown, sessionId?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sessionId) headers["x-booking-session"] = sessionId;
  const res = await fetch(`/api/sms?endpoint=${encodeURIComponent(endpoint)}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${endpoint} failed: ${res.status}`);
  return res.json();
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function PackHeatPicker({ race, date, quantity, onComplete, onBack }: PackHeatPickerProps) {
  // Mixed-track packs (weekday/weekend Intermediate + Pro 3-packs) need
  // to fetch heats from multiple underlying BMI products and let the
  // user pick any mix. Single-track Mega combos use the step-through
  // picker below.
  if (race.packType === "combo" && race.trackProducts && Object.keys(race.trackProducts).length > 1) {
    return <MixedComboPackPicker race={race} date={date} quantity={quantity} onComplete={onComplete} onBack={onBack} />;
  }
  if (race.packType === "combo") {
    return <ComboPackPicker race={race} date={date} quantity={quantity} onComplete={onComplete} onBack={onBack} />;
  }
  return <SellPackPicker race={race} date={date} quantity={quantity} onComplete={onComplete} onBack={onBack} />;
}

// ── Mixed-track Combo Pack Picker (weekday/weekend — Red + Blue) ───────────
// Fetches dayplanner from each track's product, merges, lets the guest
// pick N heats from the combined pool. Each pick books against the
// product matching its track (Red heat → Red productId, etc.). Heats
// book sequentially against one orderId so all N land on one bill.

type TrackedSmsProposal = SmsProposal & { _track: string };

/** Heat-conflict rule lives in lib/heat-conflict.ts so single-race +
 *  both pack pickers share one source of truth. */

function MixedComboPackPicker({ race, date, quantity, onComplete, onBack }: PackHeatPickerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<TrackedSmsProposal[]>([]);
  const [selectedIdxs, setSelectedIdxs] = useState<number[]>([]);
  const [committing, setCommitting] = useState(false);
  const totalRaces = race.raceCount;
  const sessionRef = useRef<string>(crypto.randomUUID());
  const ctaRef = useRef<HTMLDivElement>(null);
  const trackProducts = race.trackProducts!;

  useEffect(() => {
    if (selectedIdxs.length === totalRaces) {
      setTimeout(() => ctaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
  }, [selectedIdxs.length, totalRaces]);

  const fetchHeats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const all: TrackedSmsProposal[] = [];
      // De-dup per-(track, start) so we don't double-count the same
      // Red slot but we DO keep Red+Blue at the same time as distinct
      // heats.
      const seen = new Set<string>();
      for (const [track, cfg] of Object.entries(trackProducts)) {
        const res = await sms("dayplanner/dayplanner", {
          productId: cfg.productId,
          pageId: cfg.pageId,
          quantity,
          dynamicLines: null,
          date: date.includes("T") ? date : `${date}T00:00:00`,
        }, sessionRef.current);
        for (const p of (res.proposals || [])) {
          const start = p.blocks?.[0]?.block?.start;
          const key = start ? `${track}|${start}` : "";
          if (key && !seen.has(key)) {
            seen.add(key);
            all.push({ ...p, _track: track });
          }
        }
      }
      all.sort((a, b) =>
        (a.blocks?.[0]?.block?.start || "").localeCompare(b.blocks?.[0]?.block?.start || ""),
      );
      setProposals(all);
    } catch {
      setError("Couldn't load time slots. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [date, quantity, trackProducts]);

  useEffect(() => { fetchHeats(); }, [fetchHeats]);

  function toggleSelect(idx: number) {
    setSelectedIdxs(prev => {
      if (prev.includes(idx)) return prev.filter(i => i !== idx);
      if (prev.length >= totalRaces) return prev;
      return [...prev, idx].sort((a, b) => a - b);
    });
  }

  async function handleCommit() {
    if (selectedIdxs.length !== totalRaces) return;
    setCommitting(true);
    setError(null);

    let currentBillId: string | null = null;
    const schedules: PackSchedule[] = [];
    try {
      for (let i = 0; i < selectedIdxs.length; i++) {
        const proposal = proposals[selectedIdxs[i]];
        const block = proposal.blocks?.[0]?.block;
        if (!block) throw new Error("Invalid heat selected");
        const trackCfg = trackProducts[proposal._track];
        const isFirst = i === 0;
        const payload: Record<string, unknown> = {
          productId: trackCfg.productId,
          pageId: trackCfg.pageId,
          quantity,
          dynamicLines: null,
          sellKind: 0,
          resourceId: block.resourceId || "-1",
          proposal: {
            blocks: proposal.blocks.map(pb => ({
              productId: null,
              productLineIds: pb.productLineIds || [],
              block: pb.block,
            })),
            productLineId: proposal.productLineId ?? null,
            selected: true,
          },
        };
        if (!isFirst && currentBillId) payload.billId = currentBillId;

        const result: SmsBookResponse = await sms("booking/book", payload, sessionRef.current);
        const newBillId: string | null = result.id || result.billId || currentBillId;
        if (newBillId) currentBillId = newBillId;
        schedules.push({ start: block.start, stop: block.stop, name: block.name, trackName: proposal._track });
      }
      if (!currentBillId) throw new Error("No bill created");
      await attachPackMemo(currentBillId, race);
      onComplete({ billId: currentBillId, schedules });
    } catch (err) {
      // Partial failure — cancel whatever was created so we don't leave
      // orphaned bills.
      if (currentBillId) {
        try {
          await fetch(`/api/bmi?endpoint=${encodeURIComponent(`bill/${currentBillId}/cancel`)}`, { method: "DELETE" });
        } catch { /* best-effort */ }
      }
      setError(err instanceof Error ? err.message : "Failed to book heats");
    } finally {
      setCommitting(false);
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
          Pick {totalRaces} heats — ${race.price.toFixed(2)} total · mix Red + Blue any way you like
        </p>
      </div>

      {loading ? (
        <div className="h-48 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-white/20 border-t-white/80 rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="h-48 flex flex-col items-center justify-center gap-3">
          <p className="text-red-400 text-sm">{error}</p>
          <button onClick={fetchHeats} className="text-xs text-white/50 hover:text-white underline">Retry</button>
        </div>
      ) : proposals.length === 0 ? (
        <div className="h-48 flex flex-col items-center justify-center gap-3">
          <p className="text-white/40 text-sm">No heats available.</p>
          <button onClick={onBack} className="text-xs text-white/50 hover:text-white underline">Pick a different race</button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {(() => {
              // Pre-compute the selected picks' timing so conflict
              // check is cheap per-card.
              const pickedTimed = selectedIdxs
                .map(i => {
                  const p = proposals[i];
                  const s = p?.blocks?.[0]?.block?.start;
                  return s ? { t: new Date(s.replace(/Z$/, "")).getTime(), track: p._track } : null;
                })
                .filter((x): x is { t: number; track: string } => !!x);
              return proposals.map((proposal, idx) => {
                const block = proposal.blocks?.[0]?.block;
                if (!block) return null;
                const isSelected = selectedIdxs.includes(idx);
                const isCapped = selectedIdxs.length >= totalRaces && !isSelected;
                const isLowCap = block.freeSpots < quantity;
                const blockStart = new Date(block.start.replace(/Z$/, "")).getTime();
                // Shared rule — adjacent same-track heat blocked per
                // track cadence (Red 12, Blue 15, Mega 24); cross-
                // track needs 30 min.
                const isBackToBack = !isSelected && pickedTimed.some(pick =>
                  heatsConflict(pick.t, pick.track, blockStart, proposal._track),
                );
                const isDisabled = isLowCap || isCapped || isBackToBack;
                const badgeClass =
                  proposal._track === "Red" ? "bg-red-500/20 text-red-300"
                  : proposal._track === "Blue" ? "bg-blue-500/20 text-blue-300"
                  : "bg-white/10 text-white/70";
                const spotsLabel = isBackToBack
                  ? "Too close to picked heat"
                  : isLowCap
                    ? `Need ${quantity}, only ${block.freeSpots} left`
                    : `${block.freeSpots} of ${block.capacity} open`;
                const spotsClass = isBackToBack
                  ? "text-amber-400"
                  : isLowCap
                    ? "text-red-400"
                    : block.freeSpots / block.capacity <= 0.3 ? "text-amber-400" : "text-emerald-400";
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => !isDisabled && toggleSelect(idx)}
                    disabled={isDisabled}
                    title={isBackToBack ? HEAT_CONFLICT_TOOLTIP : undefined}
                    className={`rounded-xl border p-3 text-left transition-all duration-150 ${isSelected
                      ? "border-[#00E2E5] bg-[#00E2E5]/15 ring-1 ring-[#00E2E5]/50"
                      : isDisabled
                        ? "border-white/5 bg-white/3 opacity-40 cursor-not-allowed"
                        : "border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10 cursor-pointer"}`}
                  >
                    <div className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide mb-1.5 ${badgeClass}`}>
                      {proposal._track}
                    </div>
                    <div className="text-white font-bold text-base mb-0.5">
                      {new Date(block.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                    </div>
                    <div className="text-xs font-medium text-white/60">{block.name}</div>
                    <div className={`text-[13px] font-medium mt-1 ${spotsClass}`}>{spotsLabel}</div>
                  </button>
                );
              });
            })()}
          </div>

          <div ref={ctaRef} className={`rounded-xl border p-5 transition-all duration-300 ${selectedIdxs.length === totalRaces ? "border-[#00E2E5]/40 bg-[#00E2E5]/8" : "border-white/10 bg-white/3"}`}>
            {selectedIdxs.length === totalRaces ? (
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <p className="text-white/50 text-xs mb-1">All {totalRaces} heats selected</p>
                  <p className="text-[#00E2E5] text-sm font-semibold">
                    ${race.price.toFixed(2)} for {totalRaces} races
                  </p>
                </div>
                <button
                  onClick={handleCommit}
                  disabled={committing}
                  className="shrink-0 inline-flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25 disabled:opacity-50"
                >
                  {committing ? "Booking…" : "Confirm & Continue"}
                </button>
              </div>
            ) : (
              <p className="text-white/50 text-sm text-center">
                Pick {totalRaces - selectedIdxs.length} more {totalRaces - selectedIdxs.length === 1 ? "heat" : "heats"}
                — mix Red + Blue any way you like.
              </p>
            )}
          </div>
        </>
      )}

      <button onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors block mx-auto">
        &larr; Choose a different race
      </button>
    </div>
  );
}

// ── Combo Pack Picker (Mega track) ────────────────────────────────────────────

function ComboPackPicker({ race, date, quantity, onComplete, onBack }: PackHeatPickerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<SmsProposal[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Multi-step state
  const [currentRace, setCurrentRace] = useState(0); // 0-indexed
  const totalRaces = race.raceCount;
  const [schedules, setSchedules] = useState<PackSchedule[]>([]);
  const [billId, setBillId] = useState<string | null>(null);
  const sessionRef = useRef<string>(crypto.randomUUID());
  const ctaRef = useRef<HTMLDivElement>(null);

  // Scroll to CTA on selection
  useEffect(() => {
    if (selectedIdx !== null) {
      setTimeout(() => ctaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
  }, [selectedIdx]);

  // Fetch initial heats from dayplanner (first race only)
  const fetchInitialHeats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await sms("dayplanner/dayplanner", {
        productId: race.productId,
        pageId: race.pageId,
        quantity,
        dynamicLines: null,
        date: date.includes("T") ? date : `${date}T00:00:00`,
      }, sessionRef.current);
      setProposals(res.proposals || []);
    } catch {
      setError("Couldn't load time slots. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [race.productId, race.pageId, date, quantity]);

  useEffect(() => { fetchInitialHeats(); }, [fetchInitialHeats]);

  async function handleConfirmHeat() {
    if (selectedIdx === null) return;
    setConfirming(true);
    setError(null);

    const proposal = proposals[selectedIdx];
    const block = proposal.blocks?.[0]?.block;
    if (!block) return;

    try {
      const isFirst = currentRace === 0;
      const payload: Record<string, unknown> = {
        productId: race.productId,
        pageId: race.pageId,
        quantity,
        dynamicLines: null,
        sellKind: 0,
        resourceId: block.resourceId || "-1",
        proposal: {
          blocks: proposal.blocks.map(pb => ({
            productId: null,
            productLineIds: pb.productLineIds || [],
            block: pb.block,
          })),
          productLineId: proposal.productLineId ?? null,
          selected: true,
        },
      };

      if (!isFirst && billId) {
        payload.billId = billId;
      }

      const result: SmsBookResponse = await sms("booking/book", payload, sessionRef.current);

      // Extract bill ID from first booking
      const newBillId = result.id || result.billId || billId;
      if (newBillId) setBillId(newBillId);

      // Record this schedule
      const newSchedule: PackSchedule = {
        start: block.start,
        stop: block.stop,
        name: block.name,
      };
      const updatedSchedules = [...schedules, newSchedule];
      setSchedules(updatedSchedules);

      // Check if there are more races to pick
      if (result.nextProposals && result.nextProposals.proposals.length > 0) {
        setProposals(result.nextProposals.proposals);
        setCurrentRace(currentRace + 1);
        setSelectedIdx(null);
      } else {
        // All races booked — use schedules from response if available
        const finalSchedules = result.schedules?.length
          ? result.schedules.map(s => ({ start: s.start, stop: s.stop, name: s.name }))
          : updatedSchedules;
        // Attach the no-split / no-refund policy memo to the bill
        // before the handoff, so it's on the reservation immediately.
        if (newBillId) await attachPackMemo(newBillId, race);
        onComplete({ billId: newBillId!, schedules: finalSchedules });
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
            <button onClick={fetchInitialHeats} className="text-xs text-white/50 hover:text-white underline">Retry</button>
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

      <button onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors">← Change race</button>
    </div>
  );
}

// ── Sell Pack Picker (Red/Blue weekday) ───────────────────────────────────────

interface SellRacePage {
  pageId: string;
  pageName: string;
  products: SmsProduct[]; // track options (Blue/Red) or credit options
}

function SellPackPicker({ race, date, quantity, onComplete, onBack }: PackHeatPickerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Sell flow state
  const [billId, setBillId] = useState<string | null>(null);
  const [parentBillLineId, setParentBillLineId] = useState<string | null>(null);
  const [racePages, setRacePages] = useState<SellRacePage[]>([]);

  // Current race picking state
  const [currentRace, setCurrentRace] = useState(0);
  const [schedules, setSchedules] = useState<PackSchedule[]>([]);

  // Track selection for current race
  const [selectedTrackProduct, setSelectedTrackProduct] = useState<SmsProduct | null>(null);

  // Heat selection
  const [proposals, setProposals] = useState<SmsProposal[]>([]);
  const [heatLoading, setHeatLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);

  const sessionRef = useRef<string>(crypto.randomUUID());
  const ctaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedIdx !== null) {
      setTimeout(() => ctaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
  }, [selectedIdx]);

  // Step 1: Call booking/sell to create bill and get modifier pages
  useEffect(() => {
    let cancelled = false;
    async function initSell() {
      setLoading(true);
      setError(null);
      try {
        const result: SmsSellResponse = await sms("booking/sell", [{
          productId: race.productId,
          pageId: race.pageId,
          quantity: 1,
        }], sessionRef.current);

        if (cancelled) return;

        // Extract bill ID from the response
        // The sell response creates a bill — we get it from the bill overview
        // Actually the bill ID comes back in the response data
        const sellResult = result as unknown as { id?: string; billId?: string };
        let newBillId = sellResult.id || sellResult.billId || null;

        // If no bill ID in response, we need to extract it differently
        // The HAR shows it comes as part of subsequent requests
        // Let's check the modifiers for race booking pages
        const raceModifiers = result.modifiers?.filter(m =>
          m.pageName.toLowerCase().includes("book your") &&
          m.products.some(p => p.productGroup === "Karting")
        ) || [];

        // Sort by page name to ensure First, Second, Third order
        raceModifiers.sort((a, b) => {
          const order = ["first", "second", "third", "fourth", "fifth"];
          const aIdx = order.findIndex(o => a.pageName.toLowerCase().includes(o));
          const bIdx = order.findIndex(o => b.pageName.toLowerCase().includes(o));
          return aIdx - bIdx;
        });

        // Filter each page's products to only Karting track products (exclude credits)
        const pages: SellRacePage[] = raceModifiers.map(m => ({
          pageId: m.pageId,
          pageName: m.pageName,
          products: m.products.filter(p => p.productGroup === "Karting"),
        }));

        // We also need to find the bill ID — get bill overview
        // The sell endpoint creates a bill, and the ID is often in the response
        // If not found, we'll get it from the first book call
        if (!newBillId) {
          // Try to extract from the full response object
          const fullResult = result as unknown as Record<string, unknown>;
          if (typeof fullResult.id === "string") newBillId = fullResult.id;
          else if (typeof fullResult.billId === "string") newBillId = fullResult.billId;
        }

        // The bill line ID for the parent pack product
        // We need this for subsequent sell calls (acknowledgements)
        // We'll extract it from bill overview after first successful operation
        // For now, store what we have

        setBillId(newBillId);
        setRacePages(pages);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to initialize pack");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    initSell();
    return () => { cancelled = true; };
  }, [race.productId, race.pageId]);

  // Is the selected product a race credit (use later, no heat needed)?
  const isCredit = selectedTrackProduct ? /credit/i.test(selectedTrackProduct.name) : false;

  // When a track product is selected, fetch heats for it (skip for credits)
  useEffect(() => {
    if (!selectedTrackProduct || /credit/i.test(selectedTrackProduct.name)) return;
    let cancelled = false;

    async function fetchHeats() {
      setHeatLoading(true);
      setProposals([]);
      setSelectedIdx(null);
      try {
        const res = await sms("dayplanner/dayplanner", {
          productId: selectedTrackProduct!.id,
          pageId: racePages[currentRace]?.pageId,
          quantity,
          dynamicLines: null,
          date: date.includes("T") ? date : `${date}T00:00:00`,
        }, sessionRef.current);
        if (!cancelled) setProposals(res.proposals || []);
      } catch {
        if (!cancelled) setError("Couldn't load time slots for this track.");
      } finally {
        if (!cancelled) setHeatLoading(false);
      }
    }

    fetchHeats();
    return () => { cancelled = true; };
  }, [selectedTrackProduct, currentRace, date, quantity, racePages]);

  async function handleConfirmCredit() {
    if (!selectedTrackProduct) return;
    setConfirming(true);
    setError(null);
    try {
      const payload = [{
        productId: selectedTrackProduct.id,
        pageId: racePages[currentRace].pageId,
        quantity: 1,
        billId,
        parentBillLineId,
        dynamicLines: null,
        sellKind: 2,
      }];
      await sms("booking/sell", payload, sessionRef.current);

      const newSchedule: PackSchedule = {
        start: "",
        stop: "",
        name: "Race Credit (use anytime)",
      };
      const updatedSchedules = [...schedules, newSchedule];
      setSchedules(updatedSchedules);

      if (currentRace < racePages.length - 1) {
        setCurrentRace(currentRace + 1);
        setSelectedTrackProduct(null);
        setProposals([]);
        setSelectedIdx(null);
      } else {
        onComplete({ billId: billId!, schedules: updatedSchedules });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save race credit");
    } finally {
      setConfirming(false);
    }
  }

  async function handleConfirmHeat() {
    if (selectedIdx === null || !selectedTrackProduct) return;
    setConfirming(true);
    setError(null);

    const proposal = proposals[selectedIdx];
    const block = proposal.blocks?.[0]?.block;
    if (!block) return;

    try {
      const payload: Record<string, unknown> = {
        productId: selectedTrackProduct.id,
        pageId: racePages[currentRace].pageId,
        quantity: 1,
        dynamicLines: null,
        sellKind: 2,
        resourceId: block.resourceId || "-1",
        proposal: {
          blocks: proposal.blocks.map(pb => ({
            productId: null,
            productLineIds: pb.productLineIds || [],
            block: pb.block,
          })),
          productLineId: proposal.productLineId ?? null,
          selected: true,
        },
      };

      if (billId) payload.billId = billId;
      if (parentBillLineId) payload.parentBillLineId = parentBillLineId;

      const result: SmsBookResponse = await sms("booking/book", payload, sessionRef.current);

      // Extract bill ID if not yet known
      const newBillId = result.id || result.billId || billId;
      if (newBillId && !billId) setBillId(newBillId);

      // If we don't have parentBillLineId yet, get it from bill overview
      if (!parentBillLineId && newBillId) {
        try {
          const bill = await sms("bill/overview", { billId: newBillId }, sessionRef.current);
          // Find the pack product line
          const packLine = bill.lines?.find((l: { productId: string }) => l.productId === race.productId);
          if (packLine) setParentBillLineId(packLine.id);
        } catch {
          // Non-fatal — continue anyway
        }
      }

      // Determine track name from the selected product
      const trackName = /\bblue\b/i.test(selectedTrackProduct.name) ? "Blue"
        : /\bred\b/i.test(selectedTrackProduct.name) ? "Red" : undefined;

      // Record schedule
      const newSchedule: PackSchedule = {
        start: block.start,
        stop: block.stop,
        name: block.name,
        trackName,
      };
      const updatedSchedules = [...schedules, newSchedule];
      setSchedules(updatedSchedules);

      // Move to next race or complete
      if (currentRace < racePages.length - 1) {
        setCurrentRace(currentRace + 1);
        setSelectedTrackProduct(null);
        setProposals([]);
        setSelectedIdx(null);
      } else {
        onComplete({ billId: newBillId!, schedules: updatedSchedules });
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

  const totalRaces = racePages.length || race.raceCount;
  const currentPage = racePages[currentRace];

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="text-center">
          <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-1">Setting Up Pack</h2>
          <p className="text-white/50 text-sm">{race.name}</p>
        </div>
        <div className="h-48 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-white/20 border-t-white/80 rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (error && racePages.length === 0) {
    return (
      <div className="space-y-6">
        <div className="h-48 flex flex-col items-center justify-center gap-3">
          <p className="text-red-400 text-sm">{error}</p>
          <button onClick={onBack} className="text-xs text-white/50 hover:text-white underline">← Go back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-1">Pick Your Heats</h2>
        <p className="text-white/50 text-sm">
          <span className="text-white/80">{race.name}</span> · {displayDate}
        </p>
        <p className="text-[#00E2E5] text-sm font-semibold mt-1">
          Race {currentRace + 1} of {totalRaces}
          {currentPage && <span className="text-white/40"> — {currentPage.pageName.replace(/^Book Your /, "")}</span>}
        </p>
      </div>

      <ProgressDots current={currentRace} total={totalRaces} />
      <SelectedHeats schedules={schedules} />

      {/* Track selection */}
      {currentPage && !selectedTrackProduct && (
        <div className="space-y-3">
          <p className="text-white/50 text-sm text-center">Which track for race {currentRace + 1}?</p>
          <div className="flex gap-3 max-w-sm mx-auto">
            {currentPage.products.map(prod => {
              const isBlue = /\bblue\b/i.test(prod.name);
              const isRed = /\bred\b/i.test(prod.name);
              const isCredit = /credit/i.test(prod.name);
              return (
                <button
                  key={prod.id}
                  onClick={() => setSelectedTrackProduct(prod)}
                  className={`flex-1 py-4 rounded-xl text-sm font-bold transition-all border ${
                    isBlue
                      ? "border-blue-500/30 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 hover:border-blue-500/50"
                      : isRed
                        ? "border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:border-red-500/50"
                        : isCredit
                          ? "border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 hover:border-amber-500/50"
                          : "border-white/10 bg-white/5 text-white/60 hover:bg-white/10"
                  }`}
                >
                  {isBlue ? "Blue Track" : isRed ? "Red Track" : isCredit ? "Race Credit" : prod.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Heat grid or credit confirmation */}
      {selectedTrackProduct && isCredit && (
        <>
          <div className="flex items-center justify-center gap-2">
            <span className="text-amber-400 text-xs">Race Credit — use anytime</span>
            {currentPage && currentPage.products.length > 1 && (
              <button
                onClick={() => { setSelectedTrackProduct(null); }}
                className="text-[#00E2E5] text-xs hover:underline"
              >
                Change
              </button>
            )}
          </div>
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-5">
            <p className="text-amber-300/70 text-sm mb-4">
              Save this race as a credit to use at any time. No heat selection needed.
            </p>
            <button
              onClick={handleConfirmCredit}
              disabled={confirming}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25 disabled:opacity-50"
            >
              {confirming ? (
                <div className="w-4 h-4 border-2 border-[#000418]/30 border-t-[#000418] rounded-full animate-spin" />
              ) : currentRace < (racePages.length || race.raceCount) - 1 ? (
                `Save Credit & Pick Race ${currentRace + 2} →`
              ) : (
                "Save Credit & Continue to Checkout →"
              )}
            </button>
          </div>
        </>
      )}

      {selectedTrackProduct && !isCredit && (
        <>
          {/* Show which track is selected with a change option */}
          <div className="flex items-center justify-center gap-2">
            <span className="text-white/40 text-xs">
              {/\bblue\b/i.test(selectedTrackProduct.name) ? "Blue" : /\bred\b/i.test(selectedTrackProduct.name) ? "Red" : ""} Track
            </span>
            {currentPage && currentPage.products.length > 1 && (
              <button
                onClick={() => { setSelectedTrackProduct(null); setProposals([]); setSelectedIdx(null); }}
                className="text-[#00E2E5] text-xs hover:underline"
              >
                Change
              </button>
            )}
          </div>

          {heatLoading ? (
            <div className="h-48 flex items-center justify-center">
              <div className="w-8 h-8 border-2 border-white/20 border-t-white/80 rounded-full animate-spin" />
            </div>
          ) : proposals.length === 0 ? (
            <div className="h-48 flex flex-col items-center justify-center gap-3">
              <p className="text-white/40 text-sm">No heats available on this track.</p>
              {currentPage && currentPage.products.length > 1 && (
                <button
                  onClick={() => { setSelectedTrackProduct(null); setProposals([]); }}
                  className="text-xs text-white/50 hover:text-white underline"
                >
                  Try another track
                </button>
              )}
            </div>
          ) : (
            <>
              <HeatGrid proposals={proposals} selectedIdx={selectedIdx} onSelect={setSelectedIdx} quantity={1} />

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
        </>
      )}

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/8 p-4">
          <p className="text-red-400 text-xs">{error}</p>
        </div>
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

      <button onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors">← Change race</button>
    </div>
  );
}
