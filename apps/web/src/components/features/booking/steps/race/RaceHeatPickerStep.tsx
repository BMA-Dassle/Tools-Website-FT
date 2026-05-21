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

/** Lead time required before a heat for new racers (Guest Services
 *  check-in). v1 page.tsx:2287 — 75 min for everyone unless ALL
 *  racers have a verified Pandora waiver (express lane), in which
 *  case 0. v2 doesn't have verification data yet, so we apply 75
 *  whenever ANY racer in the category is new. */
const NEW_RACER_LEAD_MINUTES = 75;

/**
 * Race step — pick heats for ONE category (adult or junior).
 *
 * v1 parity: race v1's flow is product-adult → heat-adult → product-junior
 * → heat-junior. v2 mirrors that with separate StepDef variants
 * (`RaceHeatPickerStepAdult` / `RaceHeatPickerStepJunior`); each opts into
 * visibility via isVisible checking party composition.
 *
 * Per-racer assignment (v1 page.tsx:1214-1232): when ANY returning racer
 * (party member with `bmiPersonId`) is in the current category, clicking
 * a time block opens RacerSelectorModal — the customer picks WHICH
 * returning racers go in this heat, then each becomes its own BMI bill
 * line (one bookHeat call per selected racer). If no returning racers
 * are in the category, the click books the whole category's group as
 * one BMI line with quantity = racerCount (also matches v1).
 *
 * State shape: `item.heats[]` carries ONE RaceHeatAssignment per (block ×
 * racer) so book time has the per-line racer attribution. The picker
 * dedupes by heatId for display. Each entry's `productId` resolves back
 * to its category via `getRaceProductById`.
 *
 * Conflict gating via service/conflict.ts: per-racer same-track adjacency
 * (Red 13 min, Blue 16 min, Mega 13 min) + cross-track 30 min walk
 * buffer. Different racers can race the same block simultaneously.
 */

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

const TRACK_BADGE: Record<Track, { bg: string; text: string }> = {
  Red: { bg: "bg-red-500/20", text: "text-red-300" },
  Blue: { bg: "bg-blue-500/20", text: "text-blue-300" },
  Mega: { bg: "bg-purple-500/20", text: "text-purple-300" },
};

const TRACK_CARD: Record<Track, { base: string; baseHover: string; selected: string }> = {
  Red: {
    base: "border-red-500/60 bg-red-500/[0.14]",
    baseHover: "hover:border-red-400 hover:bg-red-500/20",
    selected: "border-red-300 bg-red-500/30 ring-2 ring-red-400/70",
  },
  Blue: {
    base: "border-blue-500/60 bg-blue-500/[0.14]",
    baseHover: "hover:border-blue-400 hover:bg-blue-500/20",
    selected: "border-blue-300 bg-blue-500/30 ring-2 ring-blue-400/70",
  },
  Mega: {
    base: "border-white/10 bg-white/5",
    baseHover: "hover:border-white/25 hover:bg-white/10",
    selected: "border-[#00E2E5] bg-[#00E2E5]/15 ring-1 ring-[#00E2E5]/50",
  },
};

const NEUTRAL_CARD = {
  base: "border-white/10 bg-white/5",
  baseHover: "hover:border-[#00E2E5]/40 hover:bg-[#00E2E5]/10",
  selected: "border-[#00E2E5] bg-[#00E2E5]/15 ring-1 ring-[#00E2E5]/50",
};

const DISABLED_CARD =
  "border-white/[0.04] bg-white/[0.015] opacity-30 cursor-not-allowed grayscale";

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

/** Dedup heats[] to one entry per distinct heatId — UI works on blocks,
 *  data layer multiplies by racers at book time. */
function dedupeByHeatId(
  heats: RaceHeatAssignment[],
): Array<{ heatId: string; track: TrackOrNull; productId: string | null }> {
  const seen = new Map<string, { heatId: string; track: TrackOrNull; productId: string | null }>();
  for (const h of heats) {
    if (!h.heatId) continue;
    if (!seen.has(h.heatId)) {
      seen.set(h.heatId, { heatId: h.heatId, track: h.track, productId: h.productId });
    }
  }
  return Array.from(seen.values()).sort(
    (a, b) => parseLocal(a.heatId).getTime() - parseLocal(b.heatId).getTime(),
  );
}

/** One RaceHeatAssignment per (block × racer) — so BMI bookHeat lands one
 *  bill line per racer carrying their bmiPersonId at commit time. */
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
  const Component: StepDef<RaceItem>["Component"] = ({ item, session, onChange }) => {
    const allRacers = session.party;
    const racers = racersOfCategory(allRacers, category);
    const partySize = racers.length;
    const productId = productIdForCategory(item, category);
    const product = useMemo(() => getRaceProductById(productId), [productId]);
    const heatsNeeded = product?.raceCount ?? 1;

    // For multi-track packs where the customer locked a track in the
    // Product step (TrackPickerModal → productTrackAdult/Junior), narrow
    // the fetch + display to ONLY that track. v1 ProductPicker behaves
    // the same: once Red is picked, the heat picker only shows Red heats.
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

    // Returning racers in this category = those with a bmiPersonId.
    // v1 page.tsx:1223 — modal opens when ANY returning racer is present.
    const returningRacers = useMemo(() => racers.filter((r) => !!r.bmiPersonId), [racers]);
    const hasReturning = returningRacers.length > 0;

    // Modal state — pending heat awaits the customer's per-racer pick.
    const [pendingHeat, setPendingHeat] = useState<TrackedProposal | null>(null);

    // Heats belonging to THIS category — keyed by productIds in the
    // fetch plan (covers mixed-track packs whose heats[].productId
    // differs from the parent product.productId).
    const categoryProductIds = useMemo(
      () => new Set(fetchPlan.map((f) => f.productId)),
      [fetchPlan],
    );
    const categoryHeats = useMemo(
      () => heatsForCategory(item, categoryProductIds),
      [item.heats, categoryProductIds],
    );
    const pickedBlocks = useMemo(() => dedupeByHeatId(categoryHeats), [categoryHeats]);
    const pickedSet = new Set(pickedBlocks.map((p) => p.heatId));
    const atCap = pickedBlocks.length >= heatsNeeded;

    // New-racer guard: when ANY racer in this category is new, filter
    // out heats starting within NEW_RACER_LEAD_MINUTES of "now" so the
    // customer can't pick a heat they wouldn't reach Guest Services in
    // time for. Mirrors v1 HeatPicker:159-166.
    const anyNewInCategory = racers.some((r) => r.isNewRacer);
    const leadCutoffMs = anyNewInCategory ? Date.now() + NEW_RACER_LEAD_MINUTES * 60_000 : 0;

    // Merged + time-sorted proposal list across all tracks for this product.
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
      // Toggle off: clear all heats[] entries for this block in this category.
      if (pickedSet.has(blockId)) {
        onChange({
          heats: item.heats.filter(
            (h) => !(h.heatId === blockId && categoryProductIds.has(h.productId ?? "")),
          ),
        });
        return;
      }
      if (atCap) return;
      // v1 split:
      //  - any returning racer present → open modal (per-racer subset pick)
      //  - else → book group (all racers in category, one entry each)
      if (hasReturning) {
        setPendingHeat(tp);
        return;
      }
      const newEntries = entriesForPick(tp.block, tp.productId, tp.track, racers);
      onChange({ heats: [...item.heats, ...newEntries] });
    };

    const handleRacerSelectorConfirm = (selected: PartyMember[]) => {
      if (!pendingHeat) return;
      // Returning racers go as INDIVIDUAL bill lines (one per selected).
      // Any new racers in the category still go as a group at the same
      // block (one entry per new racer too — at book time the BMI bill
      // adds a group line for them).
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
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-4 text-sm text-amber-300">
          Pick a date first.
        </div>
      );
    }
    if (partySize === 0) {
      return (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-4 text-sm text-amber-300">
          No {category} racers in this party.
        </div>
      );
    }
    if (!product) {
      return (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-4 text-sm text-amber-300">
          Pick a {category} race first.
        </div>
      );
    }

    // Private event safety net — even though RaceDateStep already greys
    // group-event dates, a customer could deep-link or back into a
    // stale `item.date`. Render the v1 "Private Event" full-screen
    // block so they can't book against a buyout. (v1 HeatPicker:211-237.)
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
    const showTrackBadge = !!product.trackProducts;
    const displayDate = new Date(item.date + "T12:00:00").toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const categoryLabel = category === "adult" ? "Adult" : "Junior";

    return (
      <div className="space-y-6">
        <div className="text-center">
          <p className="text-xs uppercase tracking-widest text-white/40">
            {categoryLabel} · {product.name}
          </p>
          <p className="mt-1 text-sm text-white/60">{displayDate}</p>
        </div>

        <div className="mx-auto max-w-sm rounded-xl border border-white/10 bg-white/3 p-3 text-center">
          <p className="text-xs text-white/50">
            Booking for{" "}
            <span className="font-semibold text-white">
              {partySize} {categoryLabel.toLowerCase()} racer{partySize !== 1 ? "s" : ""}
            </span>
            {heatsNeeded > 1 && (
              <>
                {" · "}
                <span className="text-white/70">{heatsNeeded} heats each</span>
              </>
            )}
          </p>
        </div>

        {heatsNeeded > 1 && <ProgressDots current={pickedBlocks.length} total={heatsNeeded} />}

        {isLoading ? (
          <div className="flex h-48 items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          </div>
        ) : hasError ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-center text-sm text-red-300">
            Couldn’t load time slots. Refresh and try again.
          </div>
        ) : allProposals.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-white/3 p-4 text-center text-sm text-white/50">
            No heats available for this date.
          </div>
        ) : (
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
              const isDisabled = isLowCap || isConflict || isCapped;

              const status = isConflict
                ? { text: "text-amber-400", label: "Too close to picked heat" }
                : isLowCap
                  ? {
                      text: "text-red-400",
                      label: `Need ${partySize}, only ${block.freeSpots} left`,
                    }
                  : isCapped
                    ? { text: "text-white/40", label: "Unselect a picked heat to change" }
                    : spotsLabel(block.freeSpots, block.capacity);

              const trackTheme = tp.track ? TRACK_CARD[tp.track] : NEUTRAL_CARD;
              const cardClass = isSelected
                ? trackTheme.selected
                : isDisabled
                  ? DISABLED_CARD
                  : `${trackTheme.base} ${trackTheme.baseHover} cursor-pointer`;
              const badge = tp.track ? TRACK_BADGE[tp.track] : null;

              return (
                <button
                  key={`${block.start}-${tp.productId}-${idx}`}
                  type="button"
                  onClick={() => !isDisabled && handleClickBlock(tp)}
                  disabled={isDisabled}
                  title={isConflict ? HEAT_CONFLICT_TOOLTIP : undefined}
                  className={`rounded-xl border p-3 text-left transition-all duration-150 ${cardClass}`}
                >
                  {showTrackBadge && badge && tp.track && (
                    <div
                      className={`mb-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide uppercase ${badge.bg} ${badge.text}`}
                    >
                      {tp.track}
                    </div>
                  )}
                  <div className="mb-2 text-base font-bold text-white">
                    {formatTime(block.start)}
                  </div>
                  <div className="mb-1 text-xs font-medium text-white/60">{block.name}</div>
                  <div className={`text-[13px] font-medium ${status.text}`}>{status.label}</div>
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                    <div
                      className={`h-full rounded-full ${
                        isLowCap
                          ? "bg-red-500"
                          : block.freeSpots / block.capacity <= 0.3
                            ? "bg-amber-400"
                            : "bg-emerald-400"
                      }`}
                      style={{ width: `${(block.freeSpots / block.capacity) * 100}%` }}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {pickedBlocks.length > 0 && (
          <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-4">
            <p className="mb-2 text-xs font-semibold tracking-wider text-green-400 uppercase">
              Heats Selected
            </p>
            {pickedBlocks.map((p, i) => {
              const assigned = categoryHeats
                .filter((h) => h.heatId === p.heatId)
                .map((h) => allRacers.find((r) => r.id === h.assignedTo)?.firstName)
                .filter((name): name is string => !!name);
              return (
                <div
                  key={p.heatId}
                  className="flex items-center justify-between gap-2 text-sm text-white/70"
                >
                  <span>
                    Race {i + 1}
                    {p.track ? ` — ${p.track} Track` : ""}
                  </span>
                  <span className="flex items-center gap-2">
                    {assigned.length > 0 && (
                      <span className="text-xs text-white/40">{assigned.join(", ")}</span>
                    )}
                    <span className="text-white/40">{formatTime(p.heatId)}</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Reminders pane — v1 HeatPicker:469-479 verbatim. License
            line only renders when the category has at least one new
            racer (mirrors v1's `packageMode` gate). */}
        <div className="bg-white/3 space-y-1 rounded-xl border border-white/8 p-4 text-xs text-white/40">
          <p>
            · Arrive <strong className="text-white/60">30 minutes early</strong> for check-in.
          </p>
          {anyNewInCategory && (
            <p>
              · A <strong className="text-white/60">$4.99 license fee</strong> per first-time driver
              applies at check-in.
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

function ProgressDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-2.5 w-2.5 rounded-full transition-colors ${
            i < current
              ? "bg-green-400"
              : i === current
                ? "bg-[#00E2E5] ring-2 ring-[#00E2E5]/30"
                : "bg-white/15"
          }`}
        />
      ))}
    </div>
  );
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
  // Per-racer conflict check across this category's heats.
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
