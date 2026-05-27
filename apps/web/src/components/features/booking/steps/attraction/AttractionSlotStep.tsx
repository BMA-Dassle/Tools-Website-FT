"use client";

import { useEffect, useMemo, useState } from "react";
import type { AttractionItem, StepDef } from "~/features/booking";
import { bmiAdapter, type BmiBlock, type BmiProposal } from "~/features/booking/data/bmi";
import { resolveAttractionContext } from "~/features/booking/service/attractions";

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
}) => {
  const ctx = useMemo(
    () => (item.slug ? resolveAttractionContext(item.slug, session) : null),
    [item.slug, session],
  );

  const [slots, setSlots] = useState<SlotOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accentColor = ctx?.config.color ?? "#00E2E5";
  const isPerPerson = ctx?.config.bookingMode === "per-person";

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
            const isSelected = item.slot === block.start;
            const price =
              block.prices?.find((p) => p.depositKind === 0 && p.kind === 0)?.amount ?? null;

            return (
              <button
                key={block.start}
                type="button"
                disabled={isFull}
                onClick={() => onChange({ slot: block.start, slotProposal: proposal })}
                className={`rounded-xl border-2 p-3 text-center transition-colors ${
                  isFull
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
                  {isFull ? "Full" : block.freeSpots <= 3 ? `${block.freeSpots} left` : "Available"}
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
