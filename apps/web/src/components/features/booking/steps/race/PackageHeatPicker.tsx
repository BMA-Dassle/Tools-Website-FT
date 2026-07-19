"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { IconFlag3 } from "@tabler/icons-react";
import { bookingKeys, type PartyMember } from "~/features/booking";
import {
  bmiAdapter,
  type BmiAvailabilityResponse,
  type BmiBlock,
  type BmiProposal,
} from "~/features/booking/data/bmi";
import {
  type PackageDefinition,
  type PackageRaceComponent,
  packageHeatGapMinutes,
  packagePerRacerPrice,
} from "~/features/booking/service/packages";
import {
  heatsConflict,
  violatesMinGapAfter,
  collidesWithOtherCategory,
  crossCategoryCollisionMessage,
  HEAT_CONFLICT_TOOLTIP,
  packageGapTooltip,
} from "~/features/booking/service/conflict";
import { evaluateRaceRestrictions } from "~/features/booking/service/race-restriction-rules";
import { scheduleForDate } from "~/features/booking/service/race-pricing";
import { TRACK_BADGE, TRACK_CARD, DISABLED_CARD, TrackInfoBanner } from "./track-visuals";
import { useCrossTierBlocks } from "./useCrossTierBlocks";

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
  /** This category's roster ("who's racing" of the step's category). The
   *  picker renders them as a checklist (all pre-checked) — deselected members
   *  aren't booked for the package, and the confirm hands back the selection. */
  racers: PartyMember[];
  /** True when the party spans adults AND juniors — drives the loud
   *  "Booking: Adults / Juniors" banner (the live mixed-party confusion:
   *  "couldn't tell who I was booking", owner 2026-07-19). */
  mixedParty: boolean;
  /** The booking step's category (junior packages evaluate the junior rules). */
  category: "adult" | "junior";
  /** allReturningHaveWaivers from the step — the opening-heats signal. */
  expressEligible: boolean;
  /** Rendering on the in-center kiosk — presentation-only (rules with a
   *  kioskPresentation hide instead of grey, e.g. the VIP anchor holds). */
  kiosk?: boolean;
  /** The OTHER category's held slots across the whole session (adult heats on
   *  the junior step and vice versa) — a candidate sharing one of these
   *  (track, start) slots is greyed: adults and juniors can't share a physical
   *  session (owner 2026-07-19). The picker's own picks Map can't see them. */
  crossCategoryHeats?: Array<{ heatId: string | null; track: string | null }>;
  onConfirm: (picks: PackagePick[], selectedRacers: PartyMember[]) => void;
  onCancel: () => void;
}

interface TrackedProposal {
  component: PackageRaceComponent;
  productId: string;
  track: string;
  proposal: BmiProposal;
  block: BmiBlock;
  /** Set when a restriction rule disables (but doesn't hide) this slot — e.g.
   *  the VIP anchor reserve. Drives the disabled card label + tooltip.
   *  ("hide"-action rules drop the slot from the grid entirely, same as the
   *  single-race picker — owner 2026-07-14: "hide just like normal booking".) */
  restriction?: { cardLabel?: string; reason?: string };
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
              <span className="inline-flex items-center gap-1">
                <IconFlag3 size={14} aria-hidden />
                {c.label}
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

/**
 * "Who's in this package" roster — the loud category banner (mixed parties)
 * plus a per-member checklist. A racer does the WHOLE 2-heat package or none
 * of it (per-heat cherry-picking would break the Starter→Intermediate
 * progression), so selection lives here at package level, all pre-checked.
 * The live price line uses the SAME packagePerRacerPrice the charge builder
 * uses (checkout.ts raceItemChargeLines) — displayed == charged.
 */
export function PackageCategoryBanner({
  category,
  detail,
}: {
  category: "adult" | "junior";
  detail?: string;
}) {
  const adult = category === "adult";
  return (
    <div
      className={`rounded-xl border-2 p-3 text-center ${
        adult ? "border-[#00E2E5]/50 bg-[#00E2E5]/10" : "border-amber-400/50 bg-amber-400/10"
      }`}
    >
      <p
        className={`font-display text-xl uppercase tracking-widest ${
          adult ? "text-[#00E2E5]" : "text-amber-400"
        }`}
      >
        Booking: {adult ? "Adults" : "Juniors"}
      </p>
      {detail && <p className="mt-0.5 text-xs text-white/60">{detail}</p>}
    </div>
  );
}

function PackageRacerRoster({
  pkg,
  racers,
  selectedIds,
  onToggle,
}: {
  pkg: PackageDefinition;
  racers: PartyMember[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
}) {
  const perRacer = packagePerRacerPrice(pkg);
  const selectedCount = racers.filter((r) => selectedIds.has(r.id)).length;
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      {racers.length === 1 ? (
        <p className="text-base font-semibold text-white">
          Booking for: <span className="text-[#00E2E5]">{racers[0].firstName}</span>
        </p>
      ) : (
        <>
          <p className="mb-2 text-xs font-bold uppercase tracking-wider text-white/50">
            Racers in this package — tap to remove someone
          </p>
          <div className="space-y-1.5">
            {racers.map((r) => {
              const checked = selectedIds.has(r.id);
              return (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={checked}
                  aria-label={
                    checked
                      ? `Remove ${r.firstName} from this package`
                      : `Add ${r.firstName} to this package`
                  }
                  onClick={() => onToggle(r.id)}
                  className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                    checked
                      ? "border-[#00E2E5]/40 bg-[#00E2E5]/5"
                      : "border-white/10 bg-white/5 hover:border-white/20"
                  }`}
                >
                  <div
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors ${
                      checked ? "border-[#00E2E5] bg-[#00E2E5]" : "border-white/30"
                    }`}
                  >
                    {checked && (
                      <svg
                        className="h-3 w-3 text-[#000418]"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                  <span
                    className={`truncate text-base font-semibold ${
                      checked ? "text-white" : "text-white/50 line-through"
                    }`}
                  >
                    {r.firstName}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
      {selectedCount === 0 ? (
        <p className="mt-2 text-sm font-semibold text-amber-400">
          Select at least one racer to book this package
        </p>
      ) : (
        <p className="mt-2 text-sm text-white/70">
          ${perRacer.toFixed(2)} per racer × {selectedCount} ={" "}
          <span className="font-bold text-white">${(perRacer * selectedCount).toFixed(2)}</span>
        </p>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function PackageHeatPicker({
  pkg,
  date,
  racers,
  mixedParty,
  category,
  expressEligible,
  kiosk,
  crossCategoryHeats,
  onConfirm,
  onCancel,
}: Props) {
  // Availability is still fetched at FULL roster size (the query key omits
  // quantity, so a selection-sized fetch wouldn't refetch anyway); the
  // "enough spots" check below uses the live selected count.
  const racerCount = Math.max(1, racers.length);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(racers.map((r) => r.id)),
  );
  const selectedRacers = racers.filter((r) => selectedIds.has(r.id));
  const selectedCount = selectedRacers.length;
  const toggleRacer = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
  // Highest-sequence pick so far — headlines the step banner ("✓ Starter locked
  // in") so the hand-off to the NEXT race is unmissable (owner 2026-07-18:
  // guests picked race 1 and never realized the grid had moved on to race 2).
  const lastPicked = [...sortedComponents].reverse().find((c) => picks.has(c.ref)) ?? null;
  const stepBannerRef = useRef<HTMLDivElement>(null);

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

  // Cross-tier occupancy fan-out for the restriction rules (same signal the
  // single-race grid and the server guard read) — every single-race product on
  // the grid's tracks, quantity 1 (pure occupancy probe, matches the guard).
  const crossTierTracks = useMemo(
    () =>
      [...new Set(sortedComponents.flatMap((c) => c.tracks.map((t) => t.track)))] as Array<
        "Red" | "Blue" | "Mega"
      >,
    [sortedComponents],
  );
  const crossTierBlocks = useCrossTierBlocks({
    tracks: crossTierTracks,
    schedule: scheduleForDate(date),
    racerType: pkg.racerType === "any" ? "existing" : pkg.racerType,
    date,
    center: "fort-myers",
    quantity: 1,
  });

  // Build merged heat grid for all components, dropping/greying slots the
  // restriction rules would reject at reserve time (assertHeatBookable): a
  // pick that can't be booked must never be offered ("hide" action → dropped,
  // matching how BMI drops genuinely sold-out heats; "disable" → greyed with
  // the rule's label, e.g. "VIP Reserved").
  const allProposals = useMemo<TrackedProposal[]>(() => {
    const list: TrackedProposal[] = [];
    const nowMs = Date.now();
    queries.forEach((q, qi) => {
      const fi = fetchItems[qi];
      if (!fi || !q.data?.proposals) return;
      // This query's own blocks = the candidate tier's occupancy signal.
      const productBlocks = q.data.proposals
        .map((p) => p.blocks?.[0]?.block)
        .filter((b): b is BmiBlock => !!b)
        .map((b) => ({
          startMs: parseLocal(b.start).getTime(),
          freeSpots: b.freeSpots,
          capacity: b.capacity,
        }));
      const trackFailed = crossTierBlocks.failedTracks.has(fi.track);
      for (const p of q.data.proposals) {
        const block = p.blocks?.[0]?.block;
        if (!block) continue;
        const verdict = evaluateRaceRestrictions({
          tier: fi.comp.tier,
          category,
          track: fi.track,
          candidateStartMs: parseLocal(block.start).getTime(),
          candidateStartLocal: block.start,
          nowMs,
          productBlocks,
          // A track with a failed union member passes undefined so union-fed
          // rules no-op (fail-open pre-filter; the server guard stays
          // authoritative) instead of false-blocking on partial data.
          categoryTrackBlocks:
            category === "junior" && !trackFailed
              ? crossTierBlocks.juniorByTrack.get(fi.track)
              : undefined,
          trackAllTierBlocks: trackFailed ? undefined : crossTierBlocks.allByTrack.get(fi.track),
          expressEligible,
          kiosk,
        });
        if (verdict.blocked && verdict.action === "hide") continue;
        list.push({
          component: fi.comp,
          productId: fi.productId,
          track: fi.track,
          proposal: p as BmiProposal,
          block,
          restriction: verdict.blocked
            ? { cardLabel: verdict.cardLabel, reason: verdict.reason }
            : undefined,
        });
      }
    });
    list.sort((a, b) => parseLocal(a.block.start).getTime() - parseLocal(b.block.start).getTime());
    return list;
  }, [queries, fetchItems, category, expressEligible, kiosk, crossTierBlocks]);

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

  // When a pick hands the flow to the next race, pull the step banner back into
  // view — mid-grid the guest can't see that the header now says "pick your
  // Intermediate race" and reads the untouched grid as "nothing happened".
  useEffect(() => {
    if (pickedCount > 0 && !allPicked) {
      stepBannerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [currentComponentIdx, pickedCount, allPicked]);

  function handleClickHeat(tp: TrackedProposal) {
    if (tp.component.ref !== currentComponent?.ref) return;

    const ref = tp.component.ref;
    const existing = picks.get(ref);

    // Same product + same start = the picked card → toggle OFF. Start alone
    // isn't identity: Red and Blue run the same cadence, so the OTHER track's
    // same-time card must SWITCH the pick, not deselect it (live find
    // 2026-07-19 — both 7:48 cards rendered "Selected").
    if (
      existing &&
      existing.productId === tp.productId &&
      existing.block.start === tp.block.start
    ) {
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
    if (selectedCount === 0) return; // CTA is disabled; belt-and-braces
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
    onConfirm(result, selectedRacers);
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
          {displayDate} · {selectedCount} racer{selectedCount === 1 ? "" : "s"} · Pick{" "}
          {totalComponents} heat{totalComponents === 1 ? "" : "s"}
        </p>
      </div>

      {/* WHO is being booked — the mixed-party banner + the member checklist.
          This step books ONE category's package; without the banner the only
          adult/junior signal was the tiny step title (owner 2026-07-19:
          "couldn't tell who I was booking"). */}
      {mixedParty && (
        <PackageCategoryBanner
          category={category}
          detail={
            category === "adult"
              ? "Juniors get their own races on the next step."
              : "Adult races were picked on the previous step."
          }
        />
      )}
      <PackageRacerRoster
        pkg={pkg}
        racers={racers}
        selectedIds={selectedIds}
        onToggle={toggleRacer}
      />

      <ProgressDots current={pickedCount} total={totalComponents} />

      {/* Current-step banner — after the first pick it flips to a loud
          "race 1 locked → now pick race 2" hand-off (owner 2026-07-18). */}
      {currentComponent && !allPicked ? (
        <div
          ref={stepBannerRef}
          className={`scroll-mt-4 rounded-lg border px-4 py-2 text-center ${
            lastPicked
              ? "border-emerald-500/40 bg-emerald-500/[0.08]"
              : "border-amber-500/30 bg-amber-500/[0.06]"
          }`}
        >
          {lastPicked && picks.get(lastPicked.ref) && (
            <p className="mb-1 text-xs font-semibold text-emerald-300">
              ✓ {lastPicked.label} locked in · {formatTime(picks.get(lastPicked.ref)!.block.start)}
            </p>
          )}
          <p className="text-xs font-bold uppercase tracking-widest text-amber-300">
            {lastPicked
              ? `Now pick your ${currentComponent.label}`
              : `Step ${currentComponent.sequence} of ${totalComponents} · Pick your ${currentComponent.label}`}
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

              // Pick identity = product + start (NOT start alone) — Red and
              // Blue share the 12-min cadence, so a start-only compare marked
              // BOTH tracks' same-time cards "Selected" (live find 2026-07-19).
              const pickedForComponent = picks.get(component.ref);
              const isPicked =
                !!pickedForComponent &&
                pickedForComponent.productId === tp.productId &&
                pickedForComponent.block.start === tp.block.start;
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

              // Cross-category slot collision — the OTHER category (adults on
              // the junior step / juniors on the adult step) already holds this
              // exact (track, start) session somewhere in the cart.
              const isCrossCategory =
                !isPicked &&
                !!crossCategoryHeats?.length &&
                collidesWithOtherCategory(tp.track, tp.block.start, crossCategoryHeats);

              const isLowCap = tp.block.freeSpots < Math.max(1, selectedCount);
              // Restriction rule that disables (not hides) this slot — e.g.
              // the VIP anchor reserve (race-restriction-rules.ts).
              const isRestricted = !isPicked && !!tp.restriction;
              const isFull = isPicked
                ? true
                : isRestricted ||
                  isOtherStep ||
                  isLowCap ||
                  isConflict ||
                  isGapViolation ||
                  isCrossCategory ||
                  false;

              const statusLabel = isPicked
                ? "Selected"
                : isRestricted
                  ? (tp.restriction!.cardLabel ?? "Not available")
                  : isOtherStep
                    ? "Locked — finish the current step"
                    : isCrossCategory
                      ? category === "junior"
                        ? "Adults race at this time — pick another"
                        : "Juniors race at this time — pick another"
                      : isGapViolation && gapAnchor
                        ? `Available ${gapAnchor.minutes} min after ${gapAnchor.refLabel} ends`
                        : isConflict
                          ? "Too close to picked heat"
                          : isLowCap
                            ? `Need ${Math.max(1, selectedCount)}, only ${tp.block.freeSpots} left`
                            : spotsLabel(tp.block.freeSpots, tp.block.capacity).label;

              const statusClass = isPicked
                ? "text-emerald-300"
                : isRestricted || isOtherStep || isGapViolation || isConflict || isCrossCategory
                  ? "text-amber-400"
                  : isLowCap
                    ? "text-red-400"
                    : spotsLabel(tp.block.freeSpots, tp.block.capacity).text;

              const cardTooltip = isRestricted
                ? tp.restriction!.reason
                : isOtherStep
                  ? "Locked — clear a heat above (×) to change it"
                  : isCrossCategory
                    ? crossCategoryCollisionMessage(tp.block.start, tp.track)
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
                          : isRestricted ||
                              isConflict ||
                              isGapViolation ||
                              isOtherStep ||
                              isCrossCategory
                            ? "bg-amber-400/50"
                            : tp.block.freeSpots / tp.block.capacity <= 0.3
                              ? "bg-amber-400"
                              : "bg-emerald-400"
                      }`}
                      style={{
                        width:
                          isRestricted || isConflict || isGapViolation || isOtherStep
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
                  disabled={selectedCount === 0}
                  className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-amber-400 px-6 py-3 text-sm font-bold text-[#000418] shadow-lg shadow-amber-500/25 transition-colors hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-30"
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
