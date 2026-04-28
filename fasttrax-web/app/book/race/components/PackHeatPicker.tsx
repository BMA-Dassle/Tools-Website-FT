"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type {
  ClassifiedProduct,
  BmiProposal,
  PackSchedule,
} from "../data";
import { bookRaceHeat } from "../data";
import type { PackBookingResult } from "./OrderSummary";
import { heatsConflict, HEAT_CONFLICT_TOOLTIP } from "@/lib/heat-conflict";
import TrackInfoBanner from "./TrackInfoBanner";

/**
 * Attach a policy memo to the pack bill so ops staff see it in BMI
 * Office and on printed receipts / reservation screens.
 *
 * Fires right after all 3 heats are booked (inside handleCommit below)
 * so the memo is on the bill from creation — survives even if the
 * customer abandons checkout. For single-racer packs (the common case)
 * nothing else overwrites this memo; multi-racer group bookings in
 * OrderSummary only add a group memo when `bills.length > 1`.
 *
 * Best-effort — a memo failure must not break the booking.
 */
async function attachPackMemo(billId: string, race: ClassifiedProduct) {
  try {
    const memo =
      `** 3-RACE PACK PURCHASE (${race.name}) ** ` +
      `All 3 heats are tied to ONE racer — DO NOT split between different racers. ` +
      `No cash refunds — credits only if rescheduling is required.`;
    const qs = new URLSearchParams({ endpoint: "booking/memo" });
    // Raw JSON to preserve BMI orderId precision (matches bookRaceHeat pattern).
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

/** Shared heat-conflict rules live in lib/heat-conflict.ts. Same-track
 *  blocks only the immediately adjacent heat (Red 12 min, Blue 15 min,
 *  Mega ~24 min cadence); cross-track needs 30 min for walk + check-in. */

/** Track label color tokens — lines up with RaceTier colors elsewhere. */
const TRACK_BADGE: Record<string, { bg: string; text: string }> = {
  Red:  { bg: "bg-red-500/20",     text: "text-red-300" },
  Blue: { bg: "bg-blue-500/20",    text: "text-blue-300" },
  Mega: { bg: "bg-purple-500/20",  text: "text-purple-300" },
};

/** Per-track theming for the WHOLE heat card — same scheme as
 *  PackageHeatPicker. Mixed-track packs (weekday/weekend Intermediate
 *  3-Pack spans Red + Blue) now color-code each card by its track so
 *  the customer can scan the grid by color instead of reading every
 *  badge. Mega packs fall back to the neutral cyan-accent palette. */
const TRACK_CARD: Record<string, {
  base: string;
  baseHover: string;
  selected: string;
}> = {
  Red: {
    base:      "border-red-500/60 bg-red-500/[0.14]",
    baseHover: "hover:border-red-400 hover:bg-red-500/20",
    selected:  "border-red-300 bg-red-500/30 ring-2 ring-red-400/70",
  },
  Blue: {
    base:      "border-blue-500/60 bg-blue-500/[0.14]",
    baseHover: "hover:border-blue-400 hover:bg-blue-500/20",
    selected:  "border-blue-300 bg-blue-500/30 ring-2 ring-blue-400/70",
  },
  Mega: {
    base:      "border-white/10 bg-white/5",
    baseHover: "hover:border-white/25 hover:bg-white/10",
    selected:  "border-[#00E2E5] bg-[#00E2E5]/15 ring-1 ring-[#00E2E5]/50",
  },
};

/** Locked-card treatment — track-agnostic flat grey, very low
 *  opacity, near-invisible border. Pairs with TRACK_CARD: track-tinted
 *  = pickable, grey = at-cap / conflict / low-capacity. Same tuning
 *  as PackageHeatPicker so the two pickers feel identical. */
const DISABLED_CARD = "border-white/[0.04] bg-white/[0.015] opacity-30 cursor-not-allowed grayscale";

function HeatGrid({
  proposals,
  selectedIdxs,
  onToggle,
  quantity,
  bookedPicks,
  atCap,
  showTrackBadge,
}: {
  proposals: TrackedProposal[];
  selectedIdxs: number[];
  onToggle: (idx: number) => void;
  quantity: number;
  /** Picks currently selected — need (start + track) so same-track gap is
   *  enforced per-track on mixed-track packs but cross-track heats at
   *  the same time remain pickable. */
  bookedPicks: { start: string; track: string }[];
  /** When the user has already picked the maximum number of heats. */
  atCap: boolean;
  /** Show Red/Blue badge on each heat card (mixed-track packs). */
  showTrackBadge: boolean;
}) {
  const selectedSet = new Set(selectedIdxs);
  // Pre-compute each pick's epoch time + track for the conflict check.
  const bookedTimed = bookedPicks.map(p => ({
    t: new Date(p.start.replace(/Z$/, "")).getTime(),
    track: p.track,
  }));

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
      {proposals.map((proposal, idx) => {
        const block = proposal.blocks?.[0]?.block;
        if (!block) return null;

        const isSelected = selectedSet.has(idx);
        const blockStart = new Date(block.start.replace(/Z$/, "")).getTime();
        // Shared rule — adjacent same-track heat blocked per track
        // cadence (Red 12, Blue 15, Mega 24); cross-track needs 30 min.
        const isBackToBack = !isSelected && bookedTimed.some(pick =>
          heatsConflict(pick.t, pick.track, blockStart, proposal._track),
        );
        const isLowCap = block.freeSpots < quantity;
        const isCapped = atCap && !isSelected;
        const isDisabled = isLowCap || isBackToBack || isCapped;
        const spots = isBackToBack
          ? { text: "text-amber-400", label: "Too close to picked heat" }
          : isCapped
            ? { text: "text-white/40", label: "Unselect a picked heat to change" }
            : spotsLabel(block.freeSpots, block.capacity);
        const badge = TRACK_BADGE[proposal._track] ?? { bg: "bg-white/10", text: "text-white/70" };

        // Track-themed card colors — mixed-track packs render Red
        // and Blue heats with the matching tint so the customer
        // can scan the grid by color. Mega keeps the neutral cyan
        // accent. Disabled cards drop the track tint entirely (see
        // DISABLED_CARD): track-tinted = pickable, grey = locked.
        const trackTheme = TRACK_CARD[proposal._track] ?? TRACK_CARD.Mega;
        const cardClass = isSelected
          ? trackTheme.selected
          : isDisabled
            ? DISABLED_CARD
            : `${trackTheme.base} ${trackTheme.baseHover} cursor-pointer`;

        return (
          <button
            key={idx}
            onClick={() => !isDisabled && onToggle(idx)}
            disabled={isDisabled}
            title={isBackToBack ? HEAT_CONFLICT_TOOLTIP : undefined}
            className={`rounded-xl border p-3 text-left transition-all duration-150 ${cardClass}`}
          >
            {showTrackBadge && (
              <div className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide mb-1.5 ${badge.bg} ${badge.text}`}>
                {proposal._track}
              </div>
            )}
            <div className="text-white font-bold text-base mb-2">{formatTime(block.start)}</div>
            <div className="text-xs font-medium mb-1 text-white/60">{block.name}</div>
            <div className={`text-[13px] font-medium ${isLowCap ? "text-red-400" : spots.text}`}>
              {isLowCap ? `Need ${quantity}, only ${block.freeSpots} left` : spots.label}
            </div>
            <div className="mt-2 h-1 rounded-full bg-white/10 overflow-hidden">
              <div
                className={`h-full rounded-full ${isLowCap ? "bg-red-500" : block.freeSpots / block.capacity <= 0.3 ? "bg-amber-400" : "bg-emerald-400"}`}
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

// ── Combo Pack Picker — single-track (Mega) + mixed-track (weekday / weekend) ──

/**
 * Extend BmiProposal with the track it came from. We need this on
 * mixed-track packs (e.g. weekday Intermediate 3-Pack spanning Red +
 * Blue) so that when booking each heat we can pick the correct BMI
 * product ID for that track. For single-track packs (Mega) _track is
 * simply the pack's own track.
 */
type TrackedProposal = BmiProposal & { _track: string };

function ComboPackPicker({ race, date, quantity, onComplete, onBack }: PackHeatPickerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<TrackedProposal[]>([]);
  /** Set of selected proposal indexes. Ordered visually by proposal order (time). */
  const [selectedIdxs, setSelectedIdxs] = useState<number[]>([]);
  const [committing, setCommitting] = useState(false);
  const totalRaces = race.raceCount;
  const ctaRef = useRef<HTMLDivElement>(null);
  /** When set, we fetch dayplanner for each track-product and merge. */
  const trackProducts = race.trackProducts;
  const isMixedTrack = !!trackProducts && Object.keys(trackProducts).length > 1;

  // Scroll CTA into view when we reach the required selection count
  useEffect(() => {
    if (selectedIdxs.length === totalRaces) {
      setTimeout(() => ctaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
  }, [selectedIdxs.length, totalRaces]);

  // Fetch heats via SMS-Timing dayplanner. For single-track packs we
  // fetch one product; for mixed-track packs we fetch each entry in
  // `trackProducts` and merge, tagging each proposal with its track.
  const fetchHeats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const dateOnly = date.split("T")[0];
      const [y, m, d] = dateOnly.split("-").map(Number);
      const dayOfWeek = new Date(y, m - 1, d).getDay();
      const startHours = (dayOfWeek === 0 || dayOfWeek === 6)
        ? [11, 13, 15, 17, 19, 20, 21, 22, 23]
        : [15, 17, 18, 19, 20, 21, 22, 23];

      // Build the fetch plan: one entry per track we need to probe.
      const fetchPlan: Array<{ track: string; productId: string; pageId: string }> =
        trackProducts
          ? Object.entries(trackProducts).map(([track, p]) => ({ track, productId: p.productId, pageId: p.pageId }))
          : [{ track: race.track ?? "Mega", productId: race.productId, pageId: race.pageId }];

      const all: TrackedProposal[] = [];
      // De-dup by (track, start) — same-track same-start is a dupe from overlapping
      // hour sweeps, but Red and Blue at the same time are DIFFERENT heats to keep.
      const seen = new Set<string>();

      for (const { track, productId, pageId } of fetchPlan) {
        for (const hour of startHours) {
          const h = String(hour).padStart(2, "0");
          const res = await fetch("/api/sms?endpoint=dayplanner%2Fdayplanner", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              productId,
              pageId,
              quantity: 1,
              dynamicLines: null,
              date: `${dateOnly}T${h}:00:00.000Z`,
            }),
          });
          const data = await res.json();
          for (const p of (data.proposals || [])) {
            const start = p.blocks?.[0]?.block?.start;
            const key = start ? `${track}|${start}` : "";
            if (key && !seen.has(key)) {
              seen.add(key);
              all.push({ ...p, _track: track });
            }
          }
        }
      }
      // Sort by time; ties (same time, different tracks) keep fetch-plan order.
      all.sort((a, b) =>
        (a.blocks?.[0]?.block?.start || "").localeCompare(b.blocks?.[0]?.block?.start || "")
      );
      setProposals(all);
    } catch {
      setError("Couldn't load time slots. Please try again.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [race.productId, race.pageId, date, JSON.stringify(trackProducts ?? null)]);

  useEffect(() => { fetchHeats(); }, [fetchHeats]);

  function toggleSelect(idx: number) {
    setSelectedIdxs(prev => {
      if (prev.includes(idx)) return prev.filter(i => i !== idx);
      if (prev.length >= totalRaces) return prev; // at cap — ignore new picks
      return [...prev, idx].sort((a, b) => a - b); // keep visual order by time
    });
  }

  /** Book all selected heats sequentially against one bill, then hand off.
   *  For mixed-track packs, each heat books against the product matching
   *  its own track (Red → Red productId, Blue → Blue productId). */
  async function handleCommit() {
    if (selectedIdxs.length !== totalRaces) return;
    setCommitting(true);
    setError(null);

    let rawOrderId: string | null = null;
    const schedules: PackSchedule[] = [];
    try {
      for (const idx of selectedIdxs) {
        const proposal = proposals[idx];
        const block = proposal.blocks?.[0]?.block;
        if (!block) throw new Error("Invalid heat selected");
        // For mixed-track packs, swap productId/pageId on a per-heat
        // basis so BMI books each heat against the right track product.
        const trackCfg = trackProducts?.[proposal._track];
        const bookableProduct: ClassifiedProduct = trackCfg
          ? { ...race, productId: trackCfg.productId, pageId: trackCfg.pageId, track: proposal._track }
          : race;
        const result = await bookRaceHeat(bookableProduct, quantity, proposal, rawOrderId);
        if (result.rawOrderId) rawOrderId = result.rawOrderId;
        schedules.push({ start: block.start, stop: block.stop, name: block.name, trackName: proposal._track });
      }
      if (!rawOrderId) throw new Error("No bill created");
      // Attach the no-split / no-refund policy memo to the bill. Awaited
      // so ops staff see it immediately on the reservation, but wrapped
      // so a memo failure doesn't block the booking handoff.
      await attachPackMemo(rawOrderId, race);
      onComplete({ billId: rawOrderId, schedules });
    } catch (err) {
      // Partial failure — cancel whatever was created so we don't leave orphaned bills.
      if (rawOrderId) {
        try {
          await fetch(`/api/bmi?endpoint=${encodeURIComponent(`bill/${rawOrderId}/cancel`)}`, { method: "DELETE" });
        } catch { /* best-effort */ }
      }
      setError(err instanceof Error ? err.message : "Failed to book heats");
    } finally {
      setCommitting(false);
    }
  }

  /** Picks that are "selected" in the UI — per-track so the same-track
   *  20-min-gap rule only fires when both heats are on the same track. */
  const pickedPicks = selectedIdxs
    .map(i => {
      const p = proposals[i];
      const start = p?.blocks?.[0]?.block?.start;
      return start ? { start, track: p._track } : null;
    })
    .filter((x): x is { start: string; track: string } => !!x);

  /** Preview of what the user has picked so far (in time order). */
  const previewSchedules: PackSchedule[] = selectedIdxs.map(i => {
    const p = proposals[i];
    const block = p?.blocks?.[0]?.block;
    return block
      ? { start: block.start, stop: block.stop, name: block.name, trackName: p._track }
      : { start: "", stop: "", name: "" };
  }).filter(s => s.start);

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
          Pick {totalRaces} heats — ${race.price.toFixed(2)} total
        </p>
      </div>

      <ProgressDots current={selectedIdxs.length} total={totalRaces} />

      {/* Track guide — only on mixed-track packs (weekday/weekend
          Intermediate 3-Pack spans Red + Blue). Mirrors the
          Ultimate Qualifier picker's banner so the customer sees
          the same color-coded context above both heat grids. */}
      {isMixedTrack && (
        <TrackInfoBanner
          tracks={
            (Object.keys(trackProducts ?? {}) as Array<"Red" | "Blue" | "Mega">)
              .filter((t) => t === "Red" || t === "Blue" || t === "Mega")
          }
        />
      )}

      <SelectedHeats schedules={previewSchedules} />

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
        </div>
      ) : (
        <>
          <HeatGrid
            proposals={proposals}
            selectedIdxs={selectedIdxs}
            onToggle={toggleSelect}
            quantity={quantity}
            bookedPicks={pickedPicks}
            atCap={selectedIdxs.length >= totalRaces}
            showTrackBadge={isMixedTrack}
          />

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
                  {committing ? (
                    <>
                      <div className="w-4 h-4 border-2 border-[#000418]/30 border-t-[#000418] rounded-full animate-spin" />
                      Booking {totalRaces} heats…
                    </>
                  ) : (
                    "Confirm & Continue to Checkout →"
                  )}
                </button>
              </div>
            ) : (
              <p className="text-center text-white/40 text-sm">
                Selected <span className="text-white font-bold">{selectedIdxs.length}</span> of <span className="text-white font-bold">{totalRaces}</span> heats
              </p>
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
