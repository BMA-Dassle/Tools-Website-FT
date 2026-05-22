"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { bookingKeys } from "~/features/booking";
import {
  bmiAdapter,
  type BmiAvailabilityResponse,
  type BmiBlock,
  type BmiProposal,
} from "~/features/booking/data/bmi";
import {
  type PackageDefinition,
  type PackageRaceComponent,
  primaryTrack,
  packageHeatGapMinutes,
} from "~/features/booking/service/packages";
import { heatsConflict, violatesMinGapAfter } from "~/features/booking/service/conflict";

export interface PackagePick {
  component: PackageRaceComponent;
  productId: string;
  track: string;
  proposal: BmiProposal;
  block: BmiBlock;
}

interface Props {
  pkg: PackageDefinition;
  date: string;
  racerCount: number;
  onConfirm: (picks: PackagePick[]) => void;
  onCancel: () => void;
}

interface TrackedProposal {
  component: PackageRaceComponent;
  productId: string;
  track: string;
  proposal: BmiProposal;
  block: BmiBlock;
}

function parseLocal(iso: string): Date {
  return new Date(iso.replace(/Z$/, ""));
}

function formatTime(iso: string): string {
  return parseLocal(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const TIER_COLOR: Record<string, string> = {
  starter: "#00E2E5",
  intermediate: "#8652FF",
  pro: "#E53935",
};

export function PackageHeatPicker({ pkg, date, racerCount, onConfirm, onCancel }: Props) {
  const sortedComponents = [...pkg.races].sort((a, b) => a.sequence - b.sequence);
  const [currentComponentIdx, setCurrentComponentIdx] = useState(0);
  const [picks, setPicks] = useState<Map<string, TrackedProposal>>(new Map());

  const currentComponent = sortedComponents[currentComponentIdx];
  const allPicked = picks.size === sortedComponents.length;

  // Fetch availability for ALL components + tracks in parallel
  const fetchItems = useMemo(
    () =>
      sortedComponents.flatMap((comp) =>
        comp.tracks.map((t) => ({
          comp,
          productId: t.productId,
          pageId: t.pageId,
          track: t.track,
        })),
      ),
    [pkg.id],
  );

  const queries = useQueries({
    queries: fetchItems.map((fi) => ({
      queryKey: bookingKeys.bmi.availability({
        center: "fort-myers",
        date,
        productId: fi.productId,
      }),
      queryFn: (): Promise<BmiAvailabilityResponse> =>
        bmiAdapter.getAvailability({
          date,
          productId: fi.productId,
          pageId: fi.pageId,
          quantity: racerCount,
        }),
      staleTime: 60_000,
    })),
  });

  const isLoading = queries.some((q) => q.isLoading);

  // Build merged heat grid for all components
  const allProposals = useMemo<TrackedProposal[]>(() => {
    const list: TrackedProposal[] = [];
    queries.forEach((q, qi) => {
      const fi = fetchItems[qi];
      if (!fi || !q.data?.proposals) return;
      for (const p of q.data.proposals) {
        const block = p.blocks?.[0]?.block;
        if (!block) continue;
        list.push({
          component: fi.comp,
          productId: fi.productId,
          track: fi.track,
          proposal: p as BmiProposal,
          block,
        });
      }
    });
    list.sort((a, b) => parseLocal(a.block.start).getTime() - parseLocal(b.block.start).getTime());
    return list;
  }, [queries, fetchItems]);

  function isPickable(tp: TrackedProposal): { ok: boolean; reason?: string } {
    if (tp.component.ref !== currentComponent?.ref) {
      return { ok: false, reason: "Complete the current step first" };
    }
    if (tp.block.freeSpots < racerCount) {
      return { ok: false, reason: `Need ${racerCount}, only ${tp.block.freeSpots} left` };
    }

    // Check gap rule against earlier component picks
    const gap = packageHeatGapMinutes(tp.component);
    if (gap) {
      const prevPick = picks.get(gap.ref);
      if (prevPick) {
        if (violatesMinGapAfter(prevPick.block.stop, tp.block.start, gap.minutes)) {
          return {
            ok: false,
            reason: `Available ${gap.minutes} min after your ${gap.ref} ends`,
          };
        }
      }
    }

    // Check standard heat conflict with all existing picks
    for (const [, existing] of picks) {
      if (
        heatsConflict(
          parseLocal(existing.block.start).getTime(),
          existing.track,
          parseLocal(tp.block.start).getTime(),
          tp.track,
        )
      ) {
        return { ok: false, reason: "Too close to a picked heat" };
      }
    }

    return { ok: true };
  }

  function handleClickHeat(tp: TrackedProposal) {
    const { ok } = isPickable(tp);
    if (!ok) return;

    const ref = tp.component.ref;
    const existing = picks.get(ref);

    if (existing && existing.block.start === tp.block.start) {
      // Deselect — also clear all later picks (gap rule cascades)
      const newPicks = new Map(picks);
      newPicks.delete(ref);
      for (const comp of sortedComponents) {
        if (comp.sequence > tp.component.sequence) {
          newPicks.delete(comp.ref);
        }
      }
      setPicks(newPicks);
      return;
    }

    // Select (replaces any prior pick for this component + clears later)
    const newPicks = new Map(picks);
    newPicks.set(ref, tp);
    for (const comp of sortedComponents) {
      if (comp.sequence > tp.component.sequence) {
        newPicks.delete(comp.ref);
      }
    }
    setPicks(newPicks);

    // Auto-advance to next component if not the last
    const nextIdx = sortedComponents.findIndex((c) => !newPicks.has(c.ref));
    if (nextIdx >= 0) {
      setCurrentComponentIdx(nextIdx);
    }
  }

  // Auto-advance currentComponentIdx when picks change
  useEffect(() => {
    const nextUnpicked = sortedComponents.findIndex((c) => !picks.has(c.ref));
    if (nextUnpicked >= 0 && nextUnpicked !== currentComponentIdx) {
      setCurrentComponentIdx(nextUnpicked);
    }
  }, [picks, sortedComponents, currentComponentIdx]);

  function handleConfirm() {
    const result: PackagePick[] = sortedComponents.map((comp) => {
      const pick = picks.get(comp.ref)!;
      return {
        component: comp,
        productId: pick.productId,
        track: pick.track,
        proposal: pick.proposal,
        block: pick.block,
      };
    });
    onConfirm(result);
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">
          Pick Your Heats
        </h2>
        <p className="mt-1 text-sm text-white/50">
          {pkg.name} — {sortedComponents.length} race{sortedComponents.length !== 1 ? "s" : ""} to
          schedule
        </p>
      </div>

      {/* Selected heats pills */}
      <div className="flex flex-wrap gap-2">
        {sortedComponents.map((comp) => {
          const pick = picks.get(comp.ref);
          const color = TIER_COLOR[comp.tier] ?? "#00E2E5";
          return (
            <span
              key={comp.ref}
              className="rounded-full border px-3 py-1 text-xs font-semibold"
              style={{
                borderColor: pick ? color : "rgba(255,255,255,0.1)",
                color: pick ? color : "rgba(255,255,255,0.3)",
                backgroundColor: pick ? `${color}15` : "transparent",
              }}
            >
              {pick ? (
                <>
                  🏎️ {comp.label} · {formatTime(pick.block.start)}
                  <button
                    type="button"
                    onClick={() => {
                      const newPicks = new Map(picks);
                      newPicks.delete(comp.ref);
                      for (const c of sortedComponents) {
                        if (c.sequence > comp.sequence) newPicks.delete(c.ref);
                      }
                      setPicks(newPicks);
                      setCurrentComponentIdx(sortedComponents.indexOf(comp));
                    }}
                    className="ml-1.5 opacity-60 hover:opacity-100"
                  >
                    ×
                  </button>
                </>
              ) : (
                `${comp.label} — pick below`
              )}
            </span>
          );
        })}
      </div>

      {/* Current component indicator */}
      {currentComponent && (
        <div className="rounded-lg border border-white/10 bg-white/3 p-3 text-center text-sm">
          <span className="text-white/50">Now picking: </span>
          <span
            className="font-semibold"
            style={{ color: TIER_COLOR[currentComponent.tier] ?? "#00E2E5" }}
          >
            {currentComponent.label}
          </span>
          {packageHeatGapMinutes(currentComponent) && (
            <p className="mt-1 text-xs text-white/40">
              Must be {packageHeatGapMinutes(currentComponent)!.minutes} min after your{" "}
              {packageHeatGapMinutes(currentComponent)!.ref} race ends
            </p>
          )}
        </div>
      )}

      {/* Heat grid */}
      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {allProposals.map((tp, idx) => {
            const isCurrentComp = tp.component.ref === currentComponent?.ref;
            const isPicked = picks.get(tp.component.ref)?.block.start === tp.block.start;
            const { ok, reason } = isPickable(tp);
            const isFull = !ok && !isPicked;
            const tierColor = TIER_COLOR[tp.component.tier] ?? "#00E2E5";

            return (
              <button
                key={`${tp.block.start}-${tp.productId}-${idx}`}
                type="button"
                onClick={() => handleClickHeat(tp)}
                disabled={isFull}
                title={reason}
                className={`rounded-xl border p-3 text-left transition-all duration-150 ${
                  isPicked
                    ? "ring-1"
                    : isFull
                      ? "cursor-not-allowed opacity-30"
                      : isCurrentComp
                        ? "cursor-pointer border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10"
                        : "cursor-default border-white/5 bg-white/3 opacity-50"
                }`}
                style={
                  isPicked
                    ? {
                        borderColor: tierColor,
                        backgroundColor: `${tierColor}15`,
                        boxShadow: `0 0 0 1px ${tierColor}50`,
                      }
                    : undefined
                }
              >
                <div className="mb-0.5 flex items-center gap-1.5">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: tierColor }}
                  />
                  <span className="text-base font-bold text-white">
                    {formatTime(tp.block.start)}
                  </span>
                </div>
                <div className="mb-1 text-xs text-white/40">→ {formatTime(tp.block.stop)}</div>
                <div className="flex items-center gap-1.5 text-xs">
                  <span
                    className="rounded px-1 py-0.5 text-[10px] font-bold"
                    style={{ backgroundColor: `${tierColor}20`, color: tierColor }}
                  >
                    {tp.component.label}
                  </span>
                  {tp.component.tracks.length > 1 && (
                    <span className="text-white/30">{tp.track}</span>
                  )}
                </div>
                {reason && !isPicked && (
                  <p className="mt-1 text-[10px] text-amber-400/70">{reason}</p>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-white/15 px-5 py-2.5 text-sm font-semibold text-white/70 transition-colors hover:border-white/30 hover:text-white"
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!allPicked}
          className="rounded-xl bg-[#00E2E5] px-6 py-2.5 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          Confirm &amp; Continue →
        </button>
      </div>
    </div>
  );
}
