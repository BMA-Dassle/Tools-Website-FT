"use client";

import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import type { PartyMember, RaceHeatAssignment, RaceItem, StepDef } from "~/features/booking";
import { bookingKeys } from "~/features/booking";
import {
  bmiAdapter,
  type BmiAvailabilityResponse,
  type BmiBlock,
  type BmiProposal,
} from "~/features/booking/data";
import { getRaceProductById, type RaceProduct } from "~/features/booking/service/race-products";
import {
  findHeatConflict,
  HEAT_CONFLICT_TOOLTIP,
  heatsConflict,
} from "~/features/booking/service/conflict";
import { RacerSelectorModal } from "./RacerSelectorModal";
import { getGroupEventForDate } from "@/lib/group-events";
import { getPackage } from "~/features/booking/service/packages";
import { PackageHeatPicker, type PackagePick } from "./PackageHeatPicker";

/**
 * Race step — pick heats for ONE category (adult or junior).
 *
 * v1 parity: strict port of `apps/web/app/book/race/components/HeatPicker.tsx`.
 * Identical visual: uniform `border-white/10 bg-white/5` cards, cyan ring on
 * selection, opacity 40 on disabled. Start time + arrow + stop time + heat
 * name + status line + capacity bar — same as v1.
 *
 * v2 architectural divergences (forced, cannot mirror v1 literally):
 *   - Per-category split into `RaceHeatPickerStepAdult` / `Junior` (v2 wizard
 *     runs ONE StepDef at a time; v1's bookingCategory cycling is a single
 *     component switching internally)
 *   - No inline "Continue" CTA pane — v2's BookingFlow owns Next at the wizard
 *     footer. v1's CTA pane is a duplicate primary action.
 *   - Click-to-toggle (multi-heat 3-Pack aware) replaces v1's confirm-then-
 *     advance flow. Picked heats are visible from the cyan ring on each card.
 *   - Per-racer assignment via RacerSelectorModal when ANY returning racer is
 *     in the category — `item.heats` carries one entry per (block × racer)
 *     so BMI bookHeat (commit 10) lands one bill line per racer with the
 *     right `bmiPersonId`.
 *
 * Lead time: when any racer in the category is new, heats starting within
 * 75 min of "now" are filtered out (v1 HeatPicker:159-166 + page.tsx:2280-
 * 2288). Private event guard: full-screen "Private Event" block when the
 * date is a buyout (v1 HeatPicker:211-237).
 */

const NEW_RACER_LEAD_MINUTES = 75;

type Category = "adult" | "junior";
type Track = "Red" | "Blue" | "Mega";
type TrackOrNull = Track | null;

interface FetchPlanItem {
  productId: string;
  pageId: string;
  track: TrackOrNull;
}

interface TrackedProposal {
  proposal: BmiProposal;
  block: BmiBlock;
  productId: string;
  track: TrackOrNull;
}

function buildFetchPlan(product: RaceProduct): FetchPlanItem[] {
  if (product.trackProducts) {
    return Object.entries(product.trackProducts).map(([track, info]) => ({
      productId: info.productId,
      pageId: info.pageId,
      track: track as Track,
    }));
  }
  return [
    {
      productId: product.productId,
      pageId: product.pageId,
      track: (product.track as TrackOrNull) ?? null,
    },
  ];
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

function spotsLabel(free: number, capacity: number): { text: string; label: string } {
  if (free === 0) return { text: "text-red-400", label: "Full" };
  if (free / capacity <= 0.3) {
    return {
      text: "text-amber-400",
      label: `${free} spot${free === 1 ? "" : "s"} left`,
    };
  }
  return { text: "text-emerald-400", label: `${free} of ${capacity} open` };
}

function racersOfCategory(party: PartyMember[], category: Category): PartyMember[] {
  return party.filter((m) => (m.category ?? "adult") === category);
}

function productIdForCategory(item: RaceItem, category: Category): string | null {
  return category === "adult" ? item.productIdAdult : item.productIdJunior;
}

function heatsForCategory(item: RaceItem, productIds: Set<string>): RaceHeatAssignment[] {
  return item.heats.filter((h) => h.productId && productIds.has(h.productId));
}

function entriesForPick(
  block: BmiBlock,
  productId: string,
  track: TrackOrNull,
  racersForLine: PartyMember[],
): RaceHeatAssignment[] {
  return racersForLine.map((r) => ({
    productId,
    track,
    heatId: block.start,
    bmiLineId: null,
    assignedTo: r.id,
  }));
}

function makeHeatPickerComponent(category: Category): StepDef<RaceItem>["Component"] {
  const Component: StepDef<RaceItem>["Component"] = ({ item, session, onChange, dispatch }) => {
    const allRacers = session.party;
    const racers = racersOfCategory(allRacers, category);
    const partySize = racers.length;
    const productId = productIdForCategory(item, category);
    const product = useMemo(() => getRaceProductById(productId), [productId]);

    // Package flow: when a package is selected instead of an individual
    // product, delegate to PackageHeatPicker (v1 parity: page.tsx:2223).
    // Once the customer confirms picks, heats are written to item.heats
    // and the outer Next button (BookingFlow) handles BMI booking via
    // bookHeatsOnAdvance — same as the regular heat picker path.
    const pkg = useMemo(
      () => (productId ? null : getPackage(item.packageId)),
      [productId, item.packageId],
    );
    const packageHeatsAlreadyPicked = !!(
      pkg &&
      pkg.races.length > 0 &&
      item.heats.some((h) => h.heatId && !h.bmiLineId)
    );
    if (pkg && pkg.races.length > 0 && item.date && !packageHeatsAlreadyPicked) {
      return (
        <PackageHeatPicker
          pkg={pkg}
          date={item.date}
          racerCount={partySize}
          onConfirm={(picks: PackagePick[]) => {
            const newHeats: RaceHeatAssignment[] = picks.flatMap((pick) =>
              racers.map((r) => ({
                productId: pick.productId,
                track: pick.track as RaceHeatAssignment["track"],
                heatId: pick.block.start,
                bmiLineId: null,
                assignedTo: r.id,
              })),
            );
            onChange({ heats: [...item.heats, ...newHeats] });
          }}
          onCancel={() => dispatch({ type: "back" })}
        />
      );
    }
    if (pkg && packageHeatsAlreadyPicked) {
      const pickSummary = pkg.races.map((comp) => {
        const heat = item.heats.find(
          (h) => h.heatId && comp.tracks.some((t) => t.productId === h.productId),
        );
        return { label: comp.label, time: heat ? formatTime(heat.heatId!) : "—" };
      });
      return (
        <div className="space-y-6">
          <div className="text-center">
            <h2 className="font-display text-2xl uppercase tracking-widest text-white">
              Heats Selected
            </h2>
            <p className="mt-1 text-sm text-white/50">{pkg.name} — ready to reserve</p>
          </div>
          <div className="mx-auto max-w-md space-y-2">
            {pickSummary.map((s) => (
              <div
                key={s.label}
                className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3"
              >
                <span className="text-sm font-semibold text-white">{s.label}</span>
                <span className="text-sm text-[#00E2E5]">{s.time}</span>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onChange({ heats: item.heats.filter((h) => !!h.bmiLineId) })}
            className="mx-auto block text-sm text-white/40 underline hover:text-white/60"
          >
            Re-pick heats
          </button>
        </div>
      );
    }
    const heatsNeeded = product?.raceCount ?? 1;

    // Locked-track filter: when ProductStep TrackPickerModal set
    // productTrackAdult/Junior, only fetch that track. Mirrors v1's
    // post-modal-pick behavior where HeatPicker receives a single
    // ClassifiedProduct already narrowed to the chosen track.
    const lockedTrack = category === "adult" ? item.productTrackAdult : item.productTrackJunior;
    const fetchPlan = useMemo(() => {
      if (!product) return [];
      const full = buildFetchPlan(product);
      if (lockedTrack && full.some((f) => f.track === lockedTrack)) {
        return full.filter((f) => f.track === lockedTrack);
      }
      return full;
    }, [product, lockedTrack]);

    const queries = useQueries({
      queries: fetchPlan.map(({ productId: pid, pageId }) => ({
        queryKey: bookingKeys.bmi.availability({
          center: session.center ?? "fort-myers",
          date: item.date ?? "",
          productId: pid,
        }),
        queryFn: (): Promise<BmiAvailabilityResponse> =>
          bmiAdapter.getAvailability({
            date: item.date!,
            productId: pid,
            pageId,
            quantity: partySize > 0 ? partySize : 1,
          }),
        enabled: !!item.date && fetchPlan.length > 0 && partySize > 0,
        staleTime: 60_000,
      })),
    });

    const returningRacers = useMemo(() => racers.filter((r) => !!r.bmiPersonId), [racers]);
    const hasReturning = returningRacers.length > 0;

    const [pendingHeat, setPendingHeat] = useState<TrackedProposal | null>(null);

    const categoryProductIds = useMemo(
      () => new Set(fetchPlan.map((f) => f.productId)),
      [fetchPlan],
    );
    const categoryHeats = useMemo(
      () => heatsForCategory(item, categoryProductIds),
      [item.heats, categoryProductIds],
    );
    const pickedBlocks = useMemo(() => {
      const seen = new Set<string>();
      const out: Array<{ heatId: string; track: TrackOrNull }> = [];
      for (const h of categoryHeats) {
        if (!h.heatId || seen.has(h.heatId)) continue;
        seen.add(h.heatId);
        out.push({ heatId: h.heatId, track: h.track as TrackOrNull });
      }
      return out;
    }, [categoryHeats]);
    const pickedSet = new Set(pickedBlocks.map((p) => p.heatId));
    const atCap = pickedBlocks.length >= heatsNeeded;

    const anyNewInCategory = racers.some((r) => r.isNewRacer);
    const allReturningHaveWaivers =
      !anyNewInCategory &&
      session.party.filter((m) => !m.isNewRacer).every((m) => m.waiverValid === true);
    const leadMinutes = allReturningHaveWaivers ? 0 : NEW_RACER_LEAD_MINUTES;
    const leadCutoffMs = anyNewInCategory ? Date.now() + leadMinutes * 60_000 : 0;

    const allProposals = useMemo<TrackedProposal[]>(() => {
      const list: TrackedProposal[] = [];
      queries.forEach((q, qi) => {
        const fp = fetchPlan[qi];
        if (!fp || !q.data?.proposals) return;
        for (const p of q.data.proposals) {
          const block = p.blocks?.[0]?.block;
          if (!block) continue;
          if (leadCutoffMs > 0 && parseLocal(block.start).getTime() < leadCutoffMs) continue;
          list.push({ proposal: p, block, productId: fp.productId, track: fp.track });
        }
      });
      list.sort(
        (a, b) => parseLocal(a.block.start).getTime() - parseLocal(b.block.start).getTime(),
      );
      return list;
    }, [queries, fetchPlan, leadCutoffMs]);

    const handleClickBlock = (tp: TrackedProposal) => {
      const blockId = tp.block.start;
      if (pickedSet.has(blockId)) {
        onChange({
          heats: item.heats.filter(
            (h) => !(h.heatId === blockId && categoryProductIds.has(h.productId ?? "")),
          ),
        });
        return;
      }
      if (atCap) return;
      if (hasReturning) {
        setPendingHeat(tp);
        return;
      }
      const newEntries = entriesForPick(tp.block, tp.productId, tp.track, racers);
      onChange({ heats: [...item.heats, ...newEntries] });
    };

    const handleRacerSelectorConfirm = (selected: PartyMember[]) => {
      if (!pendingHeat) return;
      const selectedReturning = selected.filter((r) => !!r.bmiPersonId);
      const newRacersInCategory = racers.filter((r) => !r.bmiPersonId);
      const racersForThisLine = [...selectedReturning, ...newRacersInCategory];
      const newEntries = entriesForPick(
        pendingHeat.block,
        pendingHeat.productId,
        pendingHeat.track,
        racersForThisLine,
      );
      onChange({ heats: [...item.heats, ...newEntries] });
      setPendingHeat(null);
    };

    // Early returns
    if (!item.date) {
      return (
        <div className="bg-amber-500/8 rounded-xl border border-amber-500/30 p-4 text-sm text-amber-300">
          Pick a date first.
        </div>
      );
    }
    if (partySize === 0) {
      return (
        <div className="bg-amber-500/8 rounded-xl border border-amber-500/30 p-4 text-sm text-amber-300">
          No {category} racers in this party.
        </div>
      );
    }
    if (!product) {
      return (
        <div className="bg-amber-500/8 rounded-xl border border-amber-500/30 p-4 text-sm text-amber-300">
          Pick a {category} race first.
        </div>
      );
    }

    // Private event guard — v1 HeatPicker:211-237
    const groupEventBlock = getGroupEventForDate(item.date);
    if (groupEventBlock) {
      const displayDate = new Date(item.date + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      });
      return (
        <div className="space-y-6">
          <div className="text-center">
            <h2 className="font-display mb-1 text-2xl tracking-widest text-white uppercase">
              Private Event
            </h2>
            <p className="text-sm text-white/50">{displayDate}</p>
          </div>
          <div className="bg-amber-500/8 mx-auto max-w-sm space-y-3 rounded-xl border border-amber-500/30 p-6 text-center">
            <p className="text-sm font-semibold text-amber-300">
              This date is reserved for a private event and is not available for public booking.
            </p>
            <p className="text-xs text-white/40">Please choose a different date.</p>
          </div>
        </div>
      );
    }

    const isLoading = queries.some((q) => q.isLoading);
    const hasError = queries.some((q) => q.isError);
    const displayDate = new Date(item.date + "T12:00:00").toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });

    return (
      <div className="space-y-6">
        {/* Header — v1 HeatPicker:241-248 */}
        <div className="text-center">
          <h2 className="font-display mb-1 text-2xl tracking-widest text-white uppercase">
            Pick a Heat
          </h2>
          <p className="text-sm text-white/50">
            <span className="text-white/80">{product.name}</span> · {displayDate}
          </p>
        </div>

        {/* Racer count summary — v1 HeatPicker:251-258 */}
        <div className="bg-white/3 mx-auto max-w-sm rounded-xl border border-white/8 p-3 text-center">
          <p className="text-xs text-white/50">
            Booking for{" "}
            <span className="font-semibold text-white">
              {partySize} racer{partySize !== 1 ? "s" : ""}
            </span>
          </p>
        </div>

        {isLoading ? (
          <div className="flex h-48 items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          </div>
        ) : hasError ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-center">
            <p className="text-sm text-red-300">Couldn&apos;t load time slots.</p>
            <button
              type="button"
              onClick={() => queries.forEach((q) => q.refetch())}
              className="mt-2 rounded-lg border border-white/15 px-4 py-1.5 text-xs font-semibold text-white/70 transition-colors hover:border-white/30 hover:text-white"
            >
              Retry
            </button>
          </div>
        ) : allProposals.length === 0 ? (
          <div className="bg-white/3 rounded-xl border border-white/10 p-4 text-center text-sm text-white/50">
            No heats available for this date.
          </div>
        ) : (
          // Heat grid — v1 HeatPicker:280-412
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {allProposals.map((tp, idx) => {
              const block = tp.block;
              const isSelected = pickedSet.has(block.start);
              const blockStartMs = parseLocal(block.start).getTime();
              const isConflict =
                !isSelected &&
                pickedBlocks.some((p) =>
                  heatsConflict(parseLocal(p.heatId).getTime(), p.track, blockStartMs, tp.track),
                );
              const isLowCap = block.freeSpots < partySize;
              const isCapped = atCap && !isSelected;
              const isFull = isLowCap || isConflict || isCapped;
              const statusLabel = isConflict
                ? "Too close to picked heat"
                : isLowCap
                  ? `Need ${partySize}, only ${block.freeSpots} left`
                  : isCapped
                    ? "Unselect a picked heat to change"
                    : spotsLabel(block.freeSpots, block.capacity).label;
              const statusClass = isConflict
                ? "text-amber-400"
                : isLowCap
                  ? "text-red-400"
                  : isCapped
                    ? "text-white/40"
                    : spotsLabel(block.freeSpots, block.capacity).text;

              return (
                <button
                  key={`${block.start}-${tp.productId}-${idx}`}
                  type="button"
                  onClick={() => !isFull && handleClickBlock(tp)}
                  disabled={isFull}
                  title={isConflict ? HEAT_CONFLICT_TOOLTIP : undefined}
                  className={`rounded-xl border p-3 text-left transition-all duration-150 ${
                    isSelected
                      ? "border-[#00E2E5] bg-[#00E2E5]/15 ring-1 ring-[#00E2E5]/50"
                      : isFull
                        ? "bg-white/3 cursor-not-allowed border-white/5 opacity-40"
                        : "cursor-pointer border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10"
                  }`}
                >
                  <div className="mb-0.5 text-base font-bold text-white">
                    {formatTime(block.start)}
                  </div>
                  <div className="mb-2 text-xs text-white/40">→ {formatTime(block.stop)}</div>
                  <div className="mb-1 text-xs font-medium text-white/60">{block.name}</div>
                  <div className={`text-[13px] font-medium ${statusClass}`}>{statusLabel}</div>
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                    <div
                      className={`h-full rounded-full ${
                        isLowCap
                          ? "bg-red-500"
                          : isConflict
                            ? "bg-amber-400/50"
                            : block.freeSpots / block.capacity <= 0.3
                              ? "bg-amber-400"
                              : "bg-emerald-400"
                      }`}
                      style={{
                        width: isConflict ? "100%" : `${(block.freeSpots / block.capacity) * 100}%`,
                      }}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Reminders pane — v1 HeatPicker:469-479 */}
        <div className="bg-white/3 space-y-1 rounded-xl border border-white/8 p-4 text-xs text-white/40">
          <p>
            · Arrive <strong className="text-white/60">30 minutes early</strong> for check-in.
          </p>
          {anyNewInCategory && (
            <p>
              · A <strong className="text-white/60">$4.99 license fee</strong> per driver applies at
              first check-in.
            </p>
          )}
        </div>

        {pendingHeat && (
          <RacerSelectorModal
            racers={returningRacers}
            alreadyBookedMemberIds={categoryHeats
              .filter((h) => h.heatId === pendingHeat.block.start)
              .map((h) => h.assignedTo)
              .filter((id): id is string => !!id)}
            onConfirm={handleRacerSelectorConfirm}
            onCancel={() => setPendingHeat(null)}
          />
        )}
      </div>
    );
  };
  return Component;
}

function hasCategory(session: { party: PartyMember[] }, category: Category): boolean {
  return session.party.some((m) => (m.category ?? "adult") === category);
}

function canAdvanceFor(
  item: RaceItem,
  session: { party: PartyMember[] },
  category: Category,
): true | { reason: string } {
  if (!hasCategory(session, category)) return true;
  const productId = productIdForCategory(item, category);

  // Package flow: PackageHeatPicker auto-advances via dispatch("next")
  // after writing heats, so canAdvance just needs to confirm heats exist.
  if (!productId && item.packageId) {
    const pkg = getPackage(item.packageId);
    if (pkg && pkg.races.length > 0) {
      const hasHeats = item.heats.some((h) => h.heatId);
      return hasHeats ? true : { reason: "Pick your package heats." };
    }
  }

  const product = getRaceProductById(productId);
  if (!product) return { reason: `Pick a ${category} race first.` };
  const fetchPlan = buildFetchPlan(product);
  const categoryProductIds = new Set(fetchPlan.map((f) => f.productId));
  const categoryHeats = heatsForCategory(item, categoryProductIds);
  const heatsNeeded = product.raceCount ?? 1;
  const distinctBlocks = new Set(categoryHeats.filter((h) => !!h.heatId).map((h) => h.heatId!));
  if (distinctBlocks.size < heatsNeeded) {
    const remaining = heatsNeeded - distinctBlocks.size;
    return { reason: `Pick ${remaining} more ${category} heat${remaining === 1 ? "" : "s"}` };
  }
  const byMember = new Map<string, Array<{ start: string; track: string | null }>>();
  for (const h of categoryHeats) {
    if (!h.assignedTo || !h.heatId) continue;
    const list = byMember.get(h.assignedTo) ?? [];
    list.push({ start: h.heatId, track: h.track });
    byMember.set(h.assignedTo, list);
  }
  for (const heats of byMember.values()) {
    if (heats.length < 2) continue;
    if (findHeatConflict(heats)) {
      return { reason: `Two of one ${category} racer’s heats are too close` };
    }
  }
  return true;
}

export const RaceHeatPickerStepAdult: StepDef<RaceItem> = {
  id: "race-heat-adult",
  title: "Adult Heats",
  Component: makeHeatPickerComponent("adult"),
  isVisible: (_item, session) => hasCategory(session, "adult"),
  canAdvance: (item, session) => canAdvanceFor(item, session, "adult"),
};

export const RaceHeatPickerStepJunior: StepDef<RaceItem> = {
  id: "race-heat-junior",
  title: "Junior Heats",
  Component: makeHeatPickerComponent("junior"),
  isVisible: (_item, session) => hasCategory(session, "junior"),
  canAdvance: (item, session) => canAdvanceFor(item, session, "junior"),
};
