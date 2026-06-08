"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AttractionItem, RaceItem, StepDef } from "~/features/booking";
import type { BookingSession } from "~/features/booking/state/types";
import { bmiAdapter, type BmiBlock, type BmiProposal } from "~/features/booking/data/bmi";
import {
  resolveAttractionContext,
  ATTRACTIONS,
  bookAttractionOnAdvance,
} from "~/features/booking/service/attractions";
import { releaseItemBmiLines } from "~/features/booking/service/checkout";

interface SlotOption {
  proposal: BmiProposal;
  block: BmiBlock;
}

function formatTime(iso: string): string {
  const clean = iso.replace(/Z$/, "");
  return new Date(clean).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function dedupeSlots(proposals: BmiProposal[]): SlotOption[] {
  const seen = new Map<string, SlotOption>();
  for (const proposal of proposals) {
    const block = proposal.blocks[0]?.block;
    if (!block) continue;
    if (!seen.has(block.start)) {
      seen.set(block.start, { proposal, block });
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.block.start.localeCompare(b.block.start));
}

const AttractionSlotStepComponent: StepDef<AttractionItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
}) => {
  const ctx = useMemo(
    () => (item.slug ? resolveAttractionContext(item.slug, session) : null),
    [item.slug, session],
  );

  const [slots, setSlots] = useState<SlotOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Eager hold: reserve the slot with BMI the instant it's picked (not when the
  // customer hits "Add to cart"), so a busy-day time isn't lost while they
  // linger. `holdingRef` serializes holds; switching slots releases the prior
  // hold before booking the new one.
  const [holding, setHolding] = useState(false);
  const [holdingKey, setHoldingKey] = useState<string | null>(null);
  const [holdError, setHoldError] = useState<string | null>(null);
  const holdingRef = useRef(false);

  const selectSlot = async (block: BmiBlock, proposal: BmiProposal) => {
    if (holdingRef.current) return;
    if (item.slot === block.start && item.bmiLineId) return; // already held
    holdingRef.current = true;
    setHolding(true);
    setHoldingKey(block.start);
    setHoldError(null);
    try {
      // Switching away from an already-held slot — release its BMI line first so
      // it doesn't orphan on the bill.
      if (item.bmiLineId) {
        await releaseItemBmiLines(session, item);
      }
      onChange({ slot: block.start, slotProposal: proposal, bmiLineId: null });
      await bookAttractionOnAdvance(
        session,
        { ...item, slot: block.start, slotProposal: proposal, bmiLineId: null },
        dispatch,
      );
    } catch (err) {
      onChange({ slot: null, slotProposal: null, bmiLineId: null });
      setHoldError(
        err instanceof Error
          ? `Couldn't hold that time: ${err.message}`
          : "Couldn't hold that time. Please pick another.",
      );
    } finally {
      holdingRef.current = false;
      setHolding(false);
      setHoldingKey(null);
    }
  };

  const accentColor = ctx?.config.color ?? "#00E2E5";
  const isPerPerson = ctx?.config.bookingMode === "per-person";

  // Resolve this attraction's building for conflict buffer calculation
  const thisBuilding: "fasttrax" | "headpinz" = useMemo(() => {
    if (!ctx) return "headpinz";
    return ctx.location === "fasttrax" ? "fasttrax" : "headpinz";
  }, [ctx]);

  // Gather booked times from other cart items on the same date for conflict detection
  const bookedTimes = useMemo(() => {
    const times: Array<{ startMs: number; endMs: number; building: "fasttrax" | "headpinz" }> = [];
    if (!item.date) return times;

    for (const other of session.items) {
      if (other.id === item.id) continue;

      if (other.kind === "race") {
        const race = other as RaceItem;
        for (const h of race.heats) {
          if (!h.heatId) continue;
          const ms = new Date(h.heatId.replace(/Z$/, "")).getTime();
          if (isNaN(ms)) continue;
          times.push({ startMs: ms, endMs: ms + 30 * 60_000, building: "fasttrax" });
        }
      }

      if (other.kind === "attraction") {
        const attr = other as AttractionItem;
        if (!attr.slot || !attr.date || attr.date !== item.date) continue;
        const ms = new Date(attr.slot.replace(/Z$/, "")).getTime();
        if (isNaN(ms)) continue;
        const attrConfig = attr.slug ? ATTRACTIONS[attr.slug] : null;
        const attrBuilding: "fasttrax" | "headpinz" =
          attrConfig?.location === "fasttrax" ? "fasttrax" : "headpinz";
        times.push({ startMs: ms, endMs: ms + 15 * 60_000, building: attrBuilding });
      }

      if (other.kind === "bowling" || other.kind === "kbf") {
        const bowl = other as {
          bookedAt?: string | null;
          durationMinutes?: number | null;
          date?: string | null;
        };
        if (!bowl.bookedAt || bowl.date !== item.date) continue;
        const ms = new Date(bowl.bookedAt.replace(/Z$/, "")).getTime();
        if (isNaN(ms)) continue;
        const dur = bowl.durationMinutes ?? 90;
        times.push({ startMs: ms, endMs: ms + dur * 60_000, building: "headpinz" });
      }
    }
    return times;
  }, [session.items, item.id, item.date]);

  const SAME_CENTER_BUFFER_MS = 15 * 60_000;
  const CROSS_BUILDING_BUFFER_MS = 30 * 60_000;

  function isConflict(blockStart: string): boolean {
    const slotMs = new Date(blockStart.replace(/Z$/, "")).getTime();
    if (isNaN(slotMs)) return false;
    const slotEnd = slotMs + 15 * 60_000;
    for (const bt of bookedTimes) {
      const buffer =
        bt.building !== thisBuilding ? CROSS_BUILDING_BUFFER_MS : SAME_CENTER_BUFFER_MS;
      if (slotMs < bt.endMs + buffer && slotEnd > bt.startMs - buffer) return true;
    }
    return false;
  }

  useEffect(() => {
    if (!item.productId || !item.pageId || !item.date) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    bmiAdapter
      .getAvailability({
        date: item.date,
        productId: item.productId,
        pageId: item.pageId,
        quantity: item.qty,
        clientKey: ctx?.clientKey,
      })
      .then((res) => {
        if (cancelled) return;
        setSlots(dedupeSlots(res.proposals));
      })
      .catch(() => {
        if (cancelled) return;
        setError("Couldn't load time slots. Please try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [item.productId, item.pageId, item.date, item.qty, ctx?.clientKey]);

  const dateLabel = item.date
    ? new Date(item.date + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      })
    : "";

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="text-center">
        <h3 className="font-display text-2xl uppercase tracking-widest text-white">Pick a Time</h3>
        <p className="mt-1 text-sm text-white/50">{dateLabel}</p>
      </div>

      {/* Eager-hold error (the in-progress "Holding…" state shows ON the slot). */}
      {holdError && !holding && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-center text-xs text-red-300">
          {holdError}
        </div>
      )}

      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
        </div>
      ) : error ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2">
          <p className="text-sm text-red-400">{error}</p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setLoading(true);
              bmiAdapter
                .getAvailability({
                  date: item.date!,
                  productId: item.productId!,
                  pageId: item.pageId!,
                  quantity: item.qty,
                  clientKey: ctx?.clientKey,
                })
                .then((res) => setSlots(dedupeSlots(res.proposals)))
                .catch(() => setError("Still couldn't load. Please try again."))
                .finally(() => setLoading(false));
            }}
            className="text-xs text-white/50 underline hover:text-white"
          >
            Retry
          </button>
        </div>
      ) : slots.length === 0 ? (
        <p className="text-center text-sm text-white/40">
          No time slots available on this date. Go back and pick another date.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {slots.map(({ proposal, block }) => {
            const isFull = block.freeSpots < (isPerPerson ? item.qty : 1);
            const hasConflict = isConflict(block.start);
            const isDisabled = isFull || hasConflict;
            const isSelected = item.slot === block.start;
            const price =
              block.prices?.find((p) => p.depositKind === 0 && p.kind === 0)?.amount ?? null;

            const isThisHolding = holdingKey === block.start;

            return (
              <button
                key={block.start}
                type="button"
                disabled={isDisabled || holding}
                onClick={() => selectSlot(block, proposal)}
                className={`relative rounded-xl border-2 p-3 text-center transition-colors ${
                  isDisabled
                    ? "cursor-not-allowed border-white/5 bg-white/[0.01] opacity-40"
                    : isSelected
                      ? "bg-white/[0.06]"
                      : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04]"
                }`}
                style={
                  isSelected && !isFull
                    ? { borderColor: accentColor, backgroundColor: `${accentColor}10` }
                    : undefined
                }
              >
                {isThisHolding && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-[#00E2E5]/60 bg-[#000418]/85 backdrop-blur-sm">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-[#00E2E5]" />
                    <span className="text-[11px] font-semibold text-[#00E2E5]">Holding…</span>
                  </div>
                )}
                <span
                  className="block text-sm font-bold"
                  style={{ color: isSelected ? accentColor : "white" }}
                >
                  {formatTime(block.start)}
                </span>
                {price !== null && (
                  <span className="mt-0.5 block text-xs text-white/40">${price.toFixed(2)}</span>
                )}
                <span className="mt-1 block text-[10px] text-white/30">
                  {hasConflict
                    ? "Conflicts with booking"
                    : isFull
                      ? "Full"
                      : block.freeSpots <= 3
                        ? `${block.freeSpots} left`
                        : "Available"}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const AttractionSlotStep: StepDef<AttractionItem> = {
  id: "attraction-slot",
  title: "Time",
  Component: AttractionSlotStepComponent,
  isVisible: () => true,
  canAdvance: (item) => {
    if (!item.slot) return { reason: "Pick a time slot to continue." };
    return true;
  },
};
