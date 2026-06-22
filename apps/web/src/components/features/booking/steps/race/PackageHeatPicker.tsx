"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type PackageTrackOption,
  primaryTrack,
  packageHeatGapMinutes,
} from "~/features/booking/service/packages";
import {
  heatsConflict,
  violatesMinGapAfter,
  HEAT_CONFLICT_TOOLTIP,
  packageGapTooltip,
} from "~/features/booking/service/conflict";
import { TRACK_BADGE, TRACK_CARD, DISABLED_CARD, TrackInfoBanner } from "./track-visuals";

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

// ── Helpers ─────────────────────────────────────────────────────────────────

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

function spotsLabel(free: number, capacity: number): { text: string; label: string } {
  if (free === 0) return { text: "text-red-400", label: "Full" };
  if (free / capacity <= 0.3)
    return { text: "text-amber-400", label: `${free} spot${free === 1 ? "" : "s"} left` };
  return { text: "text-emerald-400", label: `${free} of ${capacity} open` };
}

// ── Color systems ───────────────────────────────────────────────────────────

const TIER_BADGE: Record<string, { bg: string; text: string }> = {
  starter: { bg: "bg-[#00E2E5]/20", text: "text-[#00E2E5]" },
  intermediate: { bg: "bg-amber-500/20", text: "text-amber-300" },
  pro: { bg: "bg-purple-500/20", text: "text-purple-300" },
};

// ── Sub-components ──────────────────────────────────────────────────────────

function ProgressDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-2.5 w-2.5 rounded-full transition-colors ${
            i < current
              ? "bg-amber-400"
              : i === current
                ? "bg-amber-500/40 ring-2 ring-amber-500/30"
                : "bg-white/15"
          }`}
        />
      ))}
    </div>
  );
}

function SelectedHeats({
  picks,
  components,
  onClearFrom,
}: {
  picks: Map<string, TrackedProposal>;
  components: PackageRaceComponent[];
  onClearFrom: (ref: string) => void;
}) {
  const filled = components.filter((c) => picks.has(c.ref));
  if (filled.length === 0) return null;
  return (
    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
      <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-emerald-400">
        Heats Selected
      </p>
      <div className="flex flex-wrap gap-2">
        {filled.map((c) => {
          const p = picks.get(c.ref)!;
          const trackSuffix = c.tracks.length > 1 ? ` ${p.track}` : "";
          return (
            <span
              key={c.ref}
              className="inline-flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-200"
            >
              <span>
                🏎️ {c.label}
                {trackSuffix} · {formatTime(p.block.start)}
              </span>
              <button
                type="button"
                aria-label={`Clear ${c.label} selection`}
                onClick={() => onClearFrom(c.ref)}
                className="-mr-1 text-base leading-none text-emerald-300/60 transition-colors hover:text-red-400"
              >
                ×
              </button>
            </span>
          );
        })}
      </div>
      <p className="mt-1.5 text-[10px] text-white/30">
        Click × on a heat to swap it (later picks reset since the gap rule re-applies).
      </p>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function PackageHeatPicker({ pkg, date, racerCount, onConfirm, onCancel }: Props) {
  const sortedComponents = useMemo(
    () => [...pkg.races].sort((a, b) => a.sequence - b.sequence),
    [pkg],
  );
  const totalComponents = sortedComponents.length;
  const ctaRef = useRef<HTMLDivElement>(null);

  const [currentComponentIdx, setCurrentComponentIdx] = useState(0);
  const [picks, setPicks] = useState<Map<string, TrackedProposal>>(new Map());

  const currentComponent = sortedComponents[currentComponentIdx] ?? null;
  const pickedCount = sortedComponents.filter((c) => picks.has(c.ref)).length;
  const allPicked = pickedCount === totalComponents;

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

  // Effective min-gap per component. Defaults to the configured value (e.g. the
  // Ultimate Qualifier's 60 min after the Starter), but when NO heat for this
  // component can satisfy that gap after the referenced pick, fall back to 30 min
  // so a late-night booking isn't dead-ended. The card-level gate already hid the
  // package if not even 30 min fits, so this only ever loosens 60 → 30.
  const effectiveGapByRef = useMemo(() => {
    const m = new Map<string, number>();
    for (const comp of sortedComponents) {
      const gap = packageHeatGapMinutes(comp);
      if (!gap) continue;
      const prev = picks.get(gap.ref);
      if (!prev) {
        m.set(comp.ref, gap.minutes);
        continue;
      }
      const compProposals = allProposals.filter((tp) => tp.component.ref === comp.ref);
      const anyFitsConfigured = compProposals.some(
        (tp) => !violatesMinGapAfter(prev.block.stop, tp.block.start, gap.minutes),
      );
      m.set(comp.ref, anyFitsConfigured ? gap.minutes : Math.min(gap.minutes, 30));
    }
    return m;
  }, [sortedComponents, picks, allProposals]);

  // Auto-scroll CTA when last pick is made
  useEffect(() => {
    if (allPicked) {
      setTimeout(() => ctaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
  }, [allPicked]);

  // Auto-advance currentComponentIdx when picks change
  useEffect(() => {
    const nextUnpicked = sortedComponents.findIndex((c) => !picks.has(c.ref));
    if (nextUnpicked >= 0 && nextUnpicked !== currentComponentIdx) {
      setCurrentComponentIdx(nextUnpicked);
    }
  }, [picks, sortedComponents, currentComponentIdx]);

  function handleClickHeat(tp: TrackedProposal) {
    if (tp.component.ref !== currentComponent?.ref) return;

    const ref = tp.component.ref;
    const existing = picks.get(ref);

    if (existing && existing.block.start === tp.block.start) {
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

    const newPicks = new Map(picks);
    newPicks.set(ref, tp);
    for (const comp of sortedComponents) {
      if (comp.sequence > tp.component.sequence) {
        newPicks.delete(comp.ref);
      }
    }
    setPicks(newPicks);

    const nextIdx = sortedComponents.findIndex((c) => !newPicks.has(c.ref));
    if (nextIdx >= 0) {
      setCurrentComponentIdx(nextIdx);
    }
  }

  const clearPickAndLater = useCallback(
    (ref: string) => {
      const target = sortedComponents.find((c) => c.ref === ref);
      if (!target) return;
      setPicks((prev) => {
        const next = new Map(prev);
        for (const c of sortedComponents) {
          if (c.sequence >= target.sequence) next.delete(c.ref);
        }
        return next;
      });
      setCurrentComponentIdx(sortedComponents.indexOf(target));
    },
    [sortedComponents],
  );

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

  const displayDate = parseLocal(date + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Header */}
      <div className="text-center">
        <p className="mb-1 text-[11px] font-bold uppercase tracking-widest text-amber-400">
          {pkg.name}
        </p>
        <h2 className="mb-1 font-display text-2xl uppercase tracking-widest text-white">
          Pick Your Heats
        </h2>
        <p className="text-sm text-white/50">
          {displayDate} · Pick {totalComponents} heat{totalComponents === 1 ? "" : "s"}
        </p>
      </div>

      <ProgressDots current={pickedCount} total={totalComponents} />

      {/* Current-step banner */}
      {currentComponent && !allPicked ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-4 py-2 text-center">
          <p className="text-xs font-bold uppercase tracking-widest text-amber-300">
            Step {currentComponent.sequence} of {totalComponents} · Pick your{" "}
            {currentComponent.label}
          </p>
          {packageHeatGapMinutes(currentComponent) && (
            <p className="mt-1 text-xs text-white/40">
              Must be {packageHeatGapMinutes(currentComponent)!.minutes} min after your{" "}
              {packageHeatGapMinutes(currentComponent)!.ref} race ends
            </p>
          )}
        </div>
      ) : allPicked ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] px-4 py-2 text-center">
          <p className="text-xs font-bold uppercase tracking-widest text-emerald-300">
            All heats selected — review and confirm below
          </p>
        </div>
      ) : null}

      {/* Track info for multi-track steps */}
      {currentComponent && currentComponent.tracks.length > 1 && (
        <TrackInfoBanner
          tracks={currentComponent.tracks.map((t) => t.track) as Array<"Red" | "Blue" | "Mega">}
        />
      )}

      <SelectedHeats picks={picks} components={sortedComponents} onClearFrom={clearPickAndLater} />

      {/* Heat grid */}
      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
        </div>
      ) : allProposals.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-3">
          <p className="text-sm text-white/40">No heats available for this date.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {allProposals.map((tp, idx) => {
              const component = tp.component;
              const tierBadge = TIER_BADGE[component.tier] ?? TIER_BADGE.starter;
              const trackBadge = TRACK_BADGE[tp.track] ?? {
                bg: "bg-white/10",
                text: "text-white/70",
              };
              const showTrackBadge = component.tracks.length > 1;

              const isPicked = picks.get(component.ref)?.block.start === tp.block.start;
              const isOtherStep = !!(currentComponent && currentComponent.ref !== component.ref);
              const blockStart = parseLocal(tp.block.start).getTime();

              // Gap rule (with the late-night 60→30 fallback from effectiveGapByRef)
              const gap = packageHeatGapMinutes(component);
              const gapMinutes = gap ? (effectiveGapByRef.get(component.ref) ?? gap.minutes) : 0;
              const prevPick = gap ? picks.get(gap.ref) : null;
              const isGapViolation =
                prevPick && gap
                  ? violatesMinGapAfter(prevPick.block.stop, tp.block.start, gapMinutes)
                  : false;
              const gapAnchor =
                prevPick && gap
                  ? { stop: prevPick.block.stop, minutes: gapMinutes, refLabel: gap.ref }
                  : null;

              // Standard heat conflict with all existing picks
              const isConflict = Array.from(picks.values()).some(
                (existing) =>
                  existing.component.ref !== component.ref &&
                  heatsConflict(
                    parseLocal(existing.block.start).getTime(),
                    existing.track,
                    blockStart,
                    tp.track,
                  ),
              );

              const isLowCap = tp.block.freeSpots < racerCount;
              const isFull = isPicked
                ? true
                : isOtherStep || isLowCap || isConflict || isGapViolation || false;

              const statusLabel = isPicked
                ? "Selected"
                : isOtherStep
                  ? "Locked — finish the current step"
                  : isGapViolation && gapAnchor
                    ? `Available ${gapAnchor.minutes} min after ${gapAnchor.refLabel} ends`
                    : isConflict
                      ? "Too close to picked heat"
                      : isLowCap
                        ? `Need ${racerCount}, only ${tp.block.freeSpots} left`
                        : spotsLabel(tp.block.freeSpots, tp.block.capacity).label;

              const statusClass = isPicked
                ? "text-emerald-300"
                : isOtherStep || isGapViolation || isConflict
                  ? "text-amber-400"
                  : isLowCap
                    ? "text-red-400"
                    : spotsLabel(tp.block.freeSpots, tp.block.capacity).text;

              const cardTooltip = isOtherStep
                ? "Locked — clear a heat above (×) to change it"
                : isGapViolation && gapAnchor
                  ? packageGapTooltip(gapAnchor.minutes, gapAnchor.refLabel)
                  : isConflict
                    ? HEAT_CONFLICT_TOOLTIP
                    : undefined;

              const trackTheme = TRACK_CARD[tp.track] ?? TRACK_CARD.Mega;
              const cardClass = isPicked
                ? trackTheme.selected
                : isFull
                  ? DISABLED_CARD
                  : `${trackTheme.base} ${trackTheme.baseHover} cursor-pointer`;

              return (
                <button
                  key={`${tp.block.start}-${tp.productId}-${idx}`}
                  type="button"
                  onClick={() => !isFull && handleClickHeat(tp)}
                  disabled={isFull}
                  title={cardTooltip}
                  className={`rounded-xl border p-3 text-left transition-all duration-150 ${cardClass}`}
                >
                  {/* Tier + track badges */}
                  <div className="mb-1.5 flex flex-wrap items-center gap-1">
                    <span
                      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${tierBadge.bg} ${tierBadge.text}`}
                    >
                      {component.tier}
                    </span>
                    {showTrackBadge && (
                      <span
                        className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${trackBadge.bg} ${trackBadge.text}`}
                      >
                        {tp.track}
                      </span>
                    )}
                  </div>
                  <div className="mb-2 text-base font-bold text-white">
                    {formatTime(tp.block.start)}
                  </div>
                  <div className="mb-1 text-xs font-medium text-white/60">{tp.block.name}</div>
                  <div className={`text-[13px] font-medium ${statusClass}`}>{statusLabel}</div>
                  {/* Capacity bar */}
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                    <div
                      className={`h-full rounded-full ${
                        isLowCap
                          ? "bg-red-500"
                          : isConflict || isGapViolation || isOtherStep
                            ? "bg-amber-400/50"
                            : tp.block.freeSpots / tp.block.capacity <= 0.3
                              ? "bg-amber-400"
                              : "bg-emerald-400"
                      }`}
                      style={{
                        width:
                          isConflict || isGapViolation || isOtherStep
                            ? "100%"
                            : `${(tp.block.freeSpots / tp.block.capacity) * 100}%`,
                      }}
                    />
                  </div>
                </button>
              );
            })}
          </div>

          {/* CTA area */}
          <div
            ref={ctaRef}
            className={`rounded-xl border p-5 transition-all duration-300 ${
              allPicked ? "border-amber-500/40 bg-amber-500/8" : "border-white/10 bg-white/3"
            }`}
          >
            {allPicked ? (
              <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
                <div>
                  <p className="mb-1 text-xs text-white/50">All {totalComponents} heats selected</p>
                  <p className="text-sm text-white/70">
                    {sortedComponents
                      .map((c) => {
                        const pick = picks.get(c.ref)!;
                        const trackSuffix = c.tracks.length > 1 ? ` ${pick.track}` : "";
                        return `${c.label}${trackSuffix} · ${formatTime(pick.block.start)}`;
                      })
                      .join(" → ")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleConfirm}
                  className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-amber-400 px-6 py-3 text-sm font-bold text-[#000418] shadow-lg shadow-amber-500/25 transition-colors hover:bg-amber-300"
                >
                  Confirm &amp; Continue →
                </button>
              </div>
            ) : (
              <p className="text-center text-sm text-white/40">
                Selected <span className="font-bold text-white">{pickedCount}</span> of{" "}
                <span className="font-bold text-white">{totalComponents}</span> heats
              </p>
            )}
          </div>
        </>
      )}

      <button
        type="button"
        onClick={onCancel}
        className="text-sm text-white/40 transition-colors hover:text-white/70"
      >
        ← Change package
      </button>
    </div>
  );
}
