"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch } from "react";
import { useQueries } from "@tanstack/react-query";
import { IconFlag3 } from "@tabler/icons-react";
import { bookingKeys, RACE_AVAILABILITY_POLL_MS, type PartyMember } from "~/features/booking";
import type { Action, BookingSession, RaceHeatAssignment, RaceItem } from "~/features/booking";
import {
  derivePackagePicks,
  rosterSyncPlan,
  type CommittedPick,
} from "~/features/booking/service/package-picks";
import { releaseHeatBmiLines } from "~/features/booking/service/checkout";
import { useEagerHeatHold } from "./useEagerHeatHold";
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
  packageLoosestGapMinutes,
  packagePerRacerPrice,
} from "~/features/booking/service/packages";
import {
  heatsConflict,
  violatesMinGapAfter,
  collidesWithOtherCategory,
  crossCategoryCollisionMessage,
  HEAT_CONFLICT_TOOLTIP,
  packageGapMinutesFor,
  packageGapTooltip,
} from "~/features/booking/service/conflict";
import { useT } from "~/features/kiosk/i18n";
import { evaluateRaceRestrictions } from "~/features/booking/service/race-restriction-rules";
import { scheduleForDate } from "~/features/booking/service/race-pricing";
import { TRACK_BADGE, TRACK_CARD, DISABLED_CARD, TrackInfoBanner } from "./track-visuals";
import { useCrossTierBlocks } from "./useCrossTierBlocks";

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
  /** Epoch ms — heats starting before this are hidden (kiosk lead time:
   *  15 min with a starter in the party, 10 min otherwise; see the
   *  KIOSK_*_LEAD_MINUTES constants in RaceHeatPickerStep). 0 = no cutoff
   *  (web keeps its existing package behavior). */
  leadCutoffMs?: number;
  /** The OTHER category's held slots across the whole session (adult heats on
   *  the junior step and vice versa) — a candidate sharing one of these
   *  (track, start) slots is greyed: adults and juniors can't share a physical
   *  session (owner 2026-07-19). */
  crossCategoryHeats?: Array<{ heatId: string | null; track: string | null }>;
  /** The wizard step contract, forwarded by the guard — the picker owns its
   *  own heat writes + eager BMI holds (single-race parity, owner 2026-07-19:
   *  "we confirm them as we're selecting races"): picks derive from item.heats
   *  and every tap holds immediately. No Confirm step, no interstitial. */
  item: RaceItem;
  session: BookingSession;
  onChange: (patch: Partial<RaceItem>) => void;
  dispatch: Dispatch<Action>;
  setBusy?: (busy: boolean) => void;
  /** Fires the host's handleNext when the FINAL component's hold lands —
   *  pick, pick, done (owner-approved auto-advance). Deferred until the hold's
   *  bmiLineIds are COMMITTED to item.heats (see the advancePending effect). */
  requestAdvance?: () => void;
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

/** Key for the resolved-gap lookup. The gap now varies by CANDIDATE TRACK (a
 *  same-track Intermediate needs less buffer than one across the park), so the
 *  component ref alone no longer identifies a single number. */
function gapKey(componentRef: string, track: string | null): string {
  return `${componentRef}|${track ?? ""}`;
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
  disabled,
}: {
  picks: Map<string, CommittedPick>;
  components: PackageRaceComponent[];
  onClearFrom: (ref: string) => void;
  disabled?: boolean;
}) {
  const filled = components.filter((c) => picks.has(c.ref));
  if (filled.length === 0) return null;
  return (
    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
      <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-emerald-400">
        Heats Locked In
      </p>
      <div className="flex flex-wrap gap-2">
        {filled.map((c) => {
          const p = picks.get(c.ref)!;
          const trackSuffix = c.tracks.length > 1 && p.track ? ` ${p.track}` : "";
          return (
            <span
              key={c.ref}
              className="inline-flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-200"
            >
              <span className="inline-flex items-center gap-1">
                <IconFlag3 size={14} aria-hidden />
                {c.label}
                {trackSuffix} · {formatTime(p.start)}
              </span>
              <button
                type="button"
                aria-label={`Clear ${c.label} selection`}
                onClick={() => onClearFrom(c.ref)}
                disabled={disabled}
                className="-mr-1 text-base leading-none text-emerald-300/60 transition-colors hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40"
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
  disabled,
}: {
  pkg: PackageDefinition;
  racers: PartyMember[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  disabled?: boolean;
}) {
  const perRacer = packagePerRacerPrice(pkg);
  const selectedCount = racers.filter((r) => selectedIds.has(r.id)).length;
  // COLLAPSED by default (owner 2026-08-10: "is the racer selection really
  // needed? everyone will be doing the same") — the default IS everyone, so
  // the checklist only appears on "Change racers". It must stay reachable:
  // deselecting here is the only in-flow way to split a party (2 of 3 take
  // the package, the third books a single race). Auto-expands when a resumed
  // session already carries a partial selection, so an existing split is
  // never hidden behind a collapsed "everyone" line.
  const [editing, setEditing] = useState(selectedCount > 0 && selectedCount < racers.length);
  if (racers.length > 1 && !editing) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-base font-semibold text-white">
            Booking for:{" "}
            <span className="text-[#00E2E5]">
              {racers
                .filter((r) => selectedIds.has(r.id))
                .map((r) => r.firstName)
                .join(", ")}
            </span>
          </p>
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={disabled}
            className="text-xs font-bold uppercase tracking-wider text-[#00E2E5]/80 transition-colors hover:text-[#00E2E5] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Change racers ›
          </button>
        </div>
        <p className="mt-1.5 text-sm text-white/70">
          ${perRacer.toFixed(2)} per racer × {selectedCount} ={" "}
          <span className="font-bold text-white">${(perRacer * selectedCount).toFixed(2)}</span>
        </p>
      </div>
    );
  }
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
                  disabled={disabled}
                  className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
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
  leadCutoffMs = 0,
  crossCategoryHeats,
  item,
  session,
  onChange,
  dispatch,
  setBusy,
  requestAdvance,
}: Props) {
  // Kiosk i18n. Only the gap note is keyed so far — the rest of this picker's
  // copy is still hardcoded English (pre-existing; see the TODO in the step
  // banner region). Falls back to English with no LocaleProvider, so the web
  // v2 flow renders unchanged.
  const t = useT();
  // Availability is still fetched at FULL roster size (the query key omits
  // quantity, so a selection-sized fetch wouldn't refetch anyway); the
  // "enough spots" check below uses the live selected count.
  const racerCount = Math.max(1, racers.length);
  // This category's heats on THIS package's SKUs — the committed picks.
  const pkgProductIds = useMemo(
    () => new Set(pkg.races.flatMap((c) => c.tracks.map((t) => t.productId))),
    [pkg],
  );
  const committedPkgHeats = item.heats.filter(
    (h) =>
      !!h.heatId &&
      (h.category ?? "adult") === category &&
      !!h.productId &&
      pkgProductIds.has(h.productId),
  );
  // Roster selection — reconciled from committed heats on back-nav/resume so
  // the checkboxes always tell the truth about who is actually held.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() =>
    committedPkgHeats.length > 0
      ? new Set(committedPkgHeats.map((h) => h.assignedTo).filter((id): id is string => !!id))
      : new Set(racers.map((r) => r.id)),
  );
  const selectedRacers = racers.filter((r) => selectedIds.has(r.id));
  const selectedCount = selectedRacers.length;
  const sortedComponents = useMemo(
    () => [...pkg.races].sort((a, b) => a.sequence - b.sequence),
    [pkg],
  );
  const totalComponents = sortedComponents.length;

  const [currentComponentIdx, setCurrentComponentIdx] = useState(0);
  // Armed when the FINAL component's hold succeeds; the effect below fires
  // requestAdvance only once the hold's bmiLineIds are visible on the
  // COMMITTED item.heats. Never advance straight from the tap handler: the
  // host's handleNext closure can predate the hold's updateHeat commits, and
  // its bookHeatsOnAdvance backstop then re-books the final component —
  // doubled BMI lines on the reservation (live find 2026-07-21, W52981:
  // Intermediate ×4 for 2 racers; the cart and charge stayed correct).
  const [advancePending, setAdvancePending] = useState(false);
  // Track filter driven by tapping a TrackInfoBanner card — scoped to the
  // CURRENT multi-track step (other steps' locked cards stay visible so the
  // guest keeps seeing the whole package). Cleared on step change below.
  const [trackFilter, setTrackFilter] = useState<"Red" | "Blue" | "Mega" | null>(null);

  const currentComponent = sortedComponents[currentComponentIdx] ?? null;
  const stepBannerRef = useRef<HTMLDivElement>(null);

  // Tap-to-hold machinery — shared with the single-race grid.
  const { holding, holdingKey, holdError, setHoldError, holdingRef, holdHeats } = useEagerHeatHold({
    item,
    session,
    onChange,
    dispatch,
    setBusy,
  });

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
      // Semi-live grid: other guests' bookings surface without navigating
      // (spot counts drop, filled heats grey) — owner 2026-07-19.
      refetchInterval: RACE_AVAILABILITY_POLL_MS,
      refetchIntervalInBackground: false,
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
        if (leadCutoffMs > 0 && parseLocal(block.start).getTime() < leadCutoffMs) continue;
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
  }, [queries, fetchItems, category, expressEligible, kiosk, leadCutoffMs, crossTierBlocks]);

  // Picks are DERIVED from item.heats (the cart is the source of truth) — each
  // tap holds immediately, so there is no local picks state to "confirm" into
  // the cart, and back-nav re-renders the live grid with picks intact.
  const proposalsLite = useMemo(
    () =>
      allProposals.map((tp) => ({
        productId: tp.productId,
        track: tp.track,
        start: tp.block.start,
        stop: tp.block.stop,
      })),
    [allProposals],
  );
  const picks = useMemo(
    () => derivePackagePicks(pkg, item.heats, category, proposalsLite),
    [pkg, item.heats, category, proposalsLite],
  );
  const pickedCount = sortedComponents.filter((c) => picks.has(c.ref)).length;
  const allPicked = pickedCount === totalComponents;
  // Highest-sequence pick so far — headlines the step banner ("✓ Starter locked
  // in") so the hand-off to the NEXT race is unmissable (owner 2026-07-18:
  // guests picked race 1 and never realized the grid had moved on to race 2).
  const lastPicked = [...sortedComponents].reverse().find((c) => picks.has(c.ref)) ?? null;

  // Display-only track filter for the CURRENT step's cards. Other components'
  // (locked / already-picked) cards always stay visible, and picks/gap/conflict
  // logic runs on the full list — hiding a track never clears a pick.
  const visibleProposals = useMemo(() => {
    if (!trackFilter || !currentComponent || currentComponent.tracks.length < 2) {
      return allProposals;
    }
    return allProposals.filter(
      (tp) => tp.component.ref !== currentComponent.ref || tp.track === trackFilter,
    );
  }, [allProposals, trackFilter, currentComponent]);

  // Effective min-gap per component AND candidate track. Two layers:
  //
  //   1. Track. The configured value (the Ultimate Qualifier's 60 min after the
  //      Starter) is the cross-track number — it budgets the walk to the other
  //      track on top of the qualify / POV / appetizer turnaround. A candidate
  //      that STAYS on the Starter's track drops the walk and only owes
  //      `sameTrackMinutes` (30). Owner 2026-08-04. Single-track variants
  //      (Mega, both juniors) are always "same track", so they're 30 flat.
  //   2. Late-night floor. When NO heat for this component can satisfy its
  //      resolved gap after the referenced pick, everything falls back to the
  //      package's LOOSEST gap so a late booking isn't dead-ended. Derived from
  //      the rule rather than a literal 30, so a variant whose relaxation moves
  //      can't leave this floor stricter than the rule it is meant to bound
  //      (Mega briefly ran 20 on 2026-08-04); PackageCard gates on the same
  //      number.
  const effectiveGapByRefTrack = useMemo(() => {
    const m = new Map<string, number>();
    for (const comp of sortedComponents) {
      const gap = packageHeatGapMinutes(comp);
      if (!gap) continue;
      const prev = picks.get(gap.ref);
      const compProposals = allProposals.filter((tp) => tp.component.ref === comp.ref);
      const resolve = (track: string | null) =>
        prev ? packageGapMinutesFor(gap, prev.track, track) : gap.minutes;
      const anyFits =
        !prev ||
        compProposals.some(
          (tp) => !violatesMinGapAfter(prev.stop, tp.block.start, resolve(tp.track)),
        );
      const loosest = packageLoosestGapMinutes(comp);
      for (const tp of compProposals) {
        const resolved = resolve(tp.track);
        m.set(gapKey(comp.ref, tp.track), anyFits ? resolved : Math.min(resolved, loosest));
      }
    }
    return m;
  }, [sortedComponents, picks, allProposals]);

  // Gap line for the current step's banner. Post-Starter the number depends on
  // whether the guest stays on that track, so read the resolved grid values and
  // spell both out rather than quoting the single configured 60.
  const gapNote = useMemo(() => {
    if (!currentComponent) return null;
    const gap = packageHeatGapMinutes(currentComponent);
    if (!gap) return null;
    const mins = allProposals
      .filter((tp) => tp.component.ref === currentComponent.ref)
      .map(
        (tp) => effectiveGapByRefTrack.get(gapKey(currentComponent.ref, tp.track)) ?? gap.minutes,
      );
    const lo = mins.length ? Math.min(...mins) : gap.minutes;
    const hi = mins.length ? Math.max(...mins) : gap.minutes;
    return lo !== hi
      ? t("racePackage.gapNoteSplit", { minutes: lo, crossMinutes: hi, ref: gap.ref })
      : t("racePackage.gapNote", { minutes: lo, ref: gap.ref });
  }, [currentComponent, allProposals, effectiveGapByRefTrack, t]);

  // Wizard auto-advance, commit-gated: fires only on a render where every
  // package heat carries its bmiLineId — i.e. the hold's updateHeat dispatches
  // have flushed. By then the host has re-rendered in the same commit, so the
  // handleNext that requestAdvance reaches (via its latest-closure ref) sees
  // the booked heats and its bookHeatsOnAdvance backstop is a true no-op.
  useEffect(() => {
    if (!advancePending) return;
    if (!allPicked) {
      setAdvancePending(false); // pick came apart (deselect) — disarm
      return;
    }
    if (committedPkgHeats.some((h) => !h.bmiLineId)) return; // commit not flushed yet
    setAdvancePending(false);
    requestAdvance?.();
  }, [advancePending, allPicked, committedPkgHeats, requestAdvance]);

  // Auto-advance currentComponentIdx when picks change
  useEffect(() => {
    const nextUnpicked = sortedComponents.findIndex((c) => !picks.has(c.ref));
    if (nextUnpicked >= 0 && nextUnpicked !== currentComponentIdx) {
      setCurrentComponentIdx(nextUnpicked);
      // The filter belongs to the step it was set on — a pick hands the flow
      // to the next race, which may be single-track or want the full grid.
      setTrackFilter(null);
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

  /** One heat entry per selected racer for a tapped card — same shape the old
   *  Confirm wrote, incl. the $0 build-key parts (tier/category). */
  function entriesForComponent(
    tp: TrackedProposal,
    forRacers: PartyMember[],
  ): RaceHeatAssignment[] {
    return forRacers.map((r) => ({
      productId: tp.productId,
      track: tp.track as RaceHeatAssignment["track"],
      tier: tp.component.tier,
      category,
      heatId: tp.block.start,
      bmiLineId: null,
      assignedTo: r.id,
    }));
  }

  /** This category's heats on components with sequence ≥ seq — a deselect/
   *  switch clears the target AND every later race (the gap rule anchors on
   *  the earlier pick). */
  const heatsFromSequence = (seq: number): RaceHeatAssignment[] => {
    const ids = new Set(
      sortedComponents
        .filter((c) => c.sequence >= seq)
        .flatMap((c) => c.tracks.map((t) => t.productId)),
    );
    return item.heats.filter(
      (h) =>
        !!h.heatId && (h.category ?? "adult") === category && !!h.productId && ids.has(h.productId),
    );
  };

  /** Deselect a component (chip × or tapping its picked card): drop its heats
   *  + every later component's from the cart, then release the BMI lines —
   *  the single-race deselect pattern (cart is the charge's source of truth,
   *  so drop first, best-effort release after). */
  async function deselectFrom(ref: string) {
    if (holdingRef.current) return;
    const target = sortedComponents.find((c) => c.ref === ref);
    if (!target) return;
    const removed = heatsFromSequence(target.sequence);
    if (removed.length === 0) return;
    const removedSet = new Set(removed);
    onChange({ heats: item.heats.filter((h) => !removedSet.has(h)) });
    setCurrentComponentIdx(sortedComponents.indexOf(target));
    setTrackFilter(null); // jumping back to an earlier step — clear its filter
    if (removed.some((h) => h.bmiLineId)) await releaseHeatBmiLines(session, removed);
  }

  /** Tap = hold. The pick is written to the cart and reserved with BMI the
   *  moment it's tapped (single-race parity — owner 2026-07-19); when the
   *  FINAL component lands, the wizard advances itself via requestAdvance
   *  (routed through handleNext so the kiosk unracered sheet + advance-time
   *  POV/memo writer still run). */
  async function handleClickHeat(tp: TrackedProposal) {
    if (holdingRef.current) return;
    const ref = tp.component.ref;
    const existing = picks.get(ref);

    // Same product + same start = the picked card → clear it (and later
    // races). Start alone isn't identity: Red and Blue run the same cadence
    // (live find 2026-07-19 — both 7:48 cards rendered "Selected").
    if (existing && existing.productId === tp.productId && existing.start === tp.block.start) {
      await deselectFrom(ref);
      return;
    }
    if (tp.component.ref !== currentComponent?.ref) return; // locked card (defensive)
    if (selectedCount === 0) return; // roster shows the pick-a-racer warning

    // Switch on the current component: release the old pick's lines first so
    // they never orphan on the bill; a failed hold then leaves the component
    // honestly unpicked (revert to the minus-old cart, not the old pick).
    let base = item.heats;
    if (existing) {
      const replaced = heatsFromSequence(tp.component.sequence);
      if (replaced.length > 0) {
        const replacedSet = new Set(replaced);
        base = item.heats.filter((h) => !replacedSet.has(h));
        if (replaced.some((h) => h.bmiLineId)) await releaseHeatBmiLines(session, replaced);
      }
    }
    const willComplete = sortedComponents.every((c) => c.ref === ref || picks.has(c.ref));
    const ok = await holdHeats(
      [...base, ...entriesForComponent(tp, selectedRacers)],
      `${tp.productId}|${tp.block.start}`,
      base,
    );
    // Arm the commit-gated advance instead of calling requestAdvance here —
    // fired pre-commit it re-books the final component (see advancePending).
    if (ok && willComplete) setAdvancePending(true);
  }

  /** Roster toggle AFTER picks may exist: per-line holds make the sync safe —
   *  OFF releases only that member's package lines, ON holds their entries
   *  for every committed component (sequence order — license twin lands on
   *  the Starter). */
  async function toggleRacer(id: string) {
    if (holdingRef.current) return;
    const nowIncluded = !selectedIds.has(id);
    const plan = rosterSyncPlan({
      memberId: id,
      nowIncluded,
      pkg,
      category,
      heats: item.heats,
      picks,
    });
    if (!nowIncluded) {
      // Unchecking the LAST racer with heats held would strand pick-shaped
      // state with nobody on it — clear the heats instead.
      if (picks.size > 0 && selectedCount === 1) {
        setHoldError(
          "At least one racer must stay on the package — clear the heats (×) to change who's racing.",
        );
        return;
      }
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (plan.toRemove.length > 0) {
        const rm = new Set(plan.toRemove);
        onChange({ heats: item.heats.filter((h) => !rm.has(h)) });
        if (plan.toRemove.some((h) => h.bmiLineId)) {
          await releaseHeatBmiLines(session, plan.toRemove);
        }
      }
      return;
    }
    if (plan.toAdd.length > 0) {
      const ok = await holdHeats([...item.heats, ...plan.toAdd], null);
      if (!ok) return; // hold failed — leave them unchecked, error banner shows
    }
    setSelectedIds((prev) => new Set(prev).add(id));
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
        onToggle={(id) => void toggleRacer(id)}
        disabled={holding}
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
              ✓ {lastPicked.label} locked in · {formatTime(picks.get(lastPicked.ref)!.start)}
            </p>
          )}
          <p className="text-xs font-bold uppercase tracking-widest text-amber-300">
            {lastPicked
              ? `Now pick your ${currentComponent.label}`
              : `Step ${currentComponent.sequence} of ${totalComponents} · Pick your ${currentComponent.label}`}
          </p>
          {gapNote && <p className="mt-1 text-xs text-white/40">{gapNote}</p>}
        </div>
      ) : allPicked ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] px-4 py-2 text-center">
          <p className="text-xs font-bold uppercase tracking-widest text-emerald-300">
            All heats locked in
          </p>
        </div>
      ) : null}

      {holdError && !holding && (
        <div className="mx-auto max-w-sm rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-center text-xs text-red-300">
          {holdError}
        </div>
      )}

      {/* Track info for multi-track steps — tapping a card filters the current
          step's heats to that track; tapping again shows all. */}
      {currentComponent && currentComponent.tracks.length > 1 && (
        <TrackInfoBanner
          tracks={currentComponent.tracks.map((t) => t.track) as Array<"Red" | "Blue" | "Mega">}
          activeTrack={trackFilter}
          onTrackClick={(t) => setTrackFilter((cur) => (cur === t ? null : t))}
        />
      )}

      <SelectedHeats
        picks={picks}
        components={sortedComponents}
        onClearFrom={(ref) => void deselectFrom(ref)}
        disabled={holding}
      />

      {/* Heat grid */}
      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
        </div>
      ) : allProposals.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-3">
          <p className="text-sm text-white/40">No heats available for this date.</p>
        </div>
      ) : visibleProposals.length === 0 ? (
        <div className="bg-white/3 rounded-xl border border-white/10 p-4 text-center text-sm text-white/50">
          No {trackFilter} Track heats for this race — tap the track above to show all.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {visibleProposals.map((tp, idx) => {
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
                pickedForComponent.start === tp.block.start;
              const isOtherStep = !!(currentComponent && currentComponent.ref !== component.ref);
              const blockStart = parseLocal(tp.block.start).getTime();
              const isThisHolding = holdingKey === `${tp.productId}|${tp.block.start}`;

              // Gap rule, resolved for THIS card's track (same-track relaxation
              // + the late-night floor) — see effectiveGapByRefTrack.
              const gap = packageHeatGapMinutes(component);
              const gapMinutes = gap
                ? (effectiveGapByRefTrack.get(gapKey(component.ref, tp.track)) ?? gap.minutes)
                : 0;
              const prevPick = gap ? picks.get(gap.ref) : null;
              const isGapViolation =
                prevPick && gap
                  ? violatesMinGapAfter(prevPick.stop, tp.block.start, gapMinutes)
                  : false;
              const gapAnchor =
                prevPick && gap
                  ? { stop: prevPick.stop, minutes: gapMinutes, refLabel: gap.ref }
                  : null;

              // Standard heat conflict with all existing picks
              const isConflict = [...picks.entries()].some(
                ([ref, existing]) =>
                  ref !== component.ref &&
                  heatsConflict(
                    parseLocal(existing.start).getTime(),
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
              const isBlocked =
                isRestricted ||
                isOtherStep ||
                isLowCap ||
                isConflict ||
                isGapViolation ||
                isCrossCategory;
              // Picked cards stay TAPPABLE (tap = clear, single-race parity);
              // everything is untappable while a hold is in flight.
              const isDisabled = holding || (!isPicked && isBlocked);
              const isFull = !isPicked && isBlocked;

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
                ? `${trackTheme.selected} cursor-pointer`
                : isFull
                  ? DISABLED_CARD
                  : `${trackTheme.base} ${trackTheme.baseHover} cursor-pointer`;

              return (
                <button
                  key={`${tp.block.start}-${tp.productId}-${idx}`}
                  type="button"
                  onClick={() => !isDisabled && void handleClickHeat(tp)}
                  disabled={isDisabled}
                  title={cardTooltip}
                  className={`relative rounded-xl border p-3 text-left transition-all duration-150 ${cardClass}`}
                >
                  {isThisHolding && (
                    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1.5 rounded-xl border border-[#00E2E5]/60 bg-[#000418]/85 backdrop-blur-sm">
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-[#00E2E5]" />
                      <span className="text-[11px] font-semibold text-[#00E2E5]">Holding…</span>
                    </div>
                  )}
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
        </>
      )}

      <button
        type="button"
        onClick={() => dispatch({ type: "back" })}
        className="text-sm text-white/40 transition-colors hover:text-white/70"
      >
        ← Change package
      </button>
    </div>
  );
}
