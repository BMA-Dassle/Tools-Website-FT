"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { BmiProposal, BmiBlock, BmiProduct } from "../data";
import { bmiPost } from "../data";
import type { PackageDefinition, PackageRaceComponent, PackageTrackOption } from "@/lib/packages";
import {
  heatsConflict,
  HEAT_CONFLICT_TOOLTIP,
  violatesMinGapAfter,
  packageGapTooltip,
} from "@/lib/heat-conflict";
import TrackInfoBanner from "./TrackInfoBanner";

/**
 * Multi-component heat picker for packages with more than one race
 * (Ultimate Qualifier — Starter Mega → Intermediate Mega ≥ 60 min
 * later). Mirrors PackHeatPicker's UX: ONE merged grid showing all
 * heats from all components tagged with their tier, ProgressDots
 * tracking picks, SelectedHeats chips previewing the selection,
 * and a single Confirm CTA at the bottom.
 *
 * Selection model:
 *   - One pick PER COMPONENT (radio per component, not Set-of-N
 *     like the race-pack flow which picks any-N-from-same-product).
 *   - Clicking a heat from component X replaces the previous pick
 *     for X. Click again to deselect.
 *   - Cross-component rules: package gap (Intermediate ≥ 60 min
 *     after Starter STOP) + standard same/cross-track adjacency.
 *
 * Outputs `{ picks: PackagePick[] }` so handlePackageHeatsConfirm
 * doesn't change.
 */

export interface PackagePick {
  component: PackageRaceComponent;
  /** The specific track/product the customer picked at heat
   *  selection time. For multi-track components (weekday / weekend
   *  Ultimate Qualifier) this resolves which BMI productId to book
   *  against — Red Starter vs. Blue Starter live on different SKUs. */
  trackOption: PackageTrackOption;
  proposal: BmiProposal;
  block: BmiBlock;
}

interface PackageHeatPickerProps {
  pkg: PackageDefinition;
  date: string;
  quantity: number;
  bookedHeats?: { start: string; stop: string; track: string | null }[];
  minAdvanceMinutes?: number;
  onConfirm: (result: { picks: PackagePick[] }) => void;
  onBack: () => void;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseLocal(iso: string): Date {
  const clean = iso.replace(/Z$/, "");
  const [datePart, timePart] = clean.split("T");
  if (!timePart) return new Date(clean);
  const [y, m, d] = datePart.split("-").map(Number);
  const [h, min, s] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, h, min, s || 0);
}

function formatTime(iso: string): string {
  return parseLocal(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function spotsLabel(free: number, capacity: number): { text: string; label: string } {
  if (free === 0) return { text: "text-red-400", label: "Full" };
  if (free / capacity <= 0.3) return { text: "text-amber-400", label: `${free} spot${free === 1 ? "" : "s"} left` };
  return { text: "text-emerald-400", label: `${free} of ${capacity} open` };
}

/** Tagged proposal — annotated with both the component ref it belongs
 *  to (which "slot") and the track it was fetched for (which BMI
 *  product it should book against). For single-track components the
 *  `_track` is just the component's only track; for multi-track
 *  components it varies per fetched proposal. */
type TaggedProposal = BmiProposal & { _componentRef: string; _track: "Red" | "Blue" | "Mega" };

/** Color tokens by tier so the badge on each card pops the way the
 *  Red/Blue/Mega track badges do on race-pack cards. */
const TIER_BADGE: Record<string, { bg: string; text: string }> = {
  starter: { bg: "bg-[#00E2E5]/20", text: "text-[#00E2E5]" },
  intermediate: { bg: "bg-amber-500/20", text: "text-amber-300" },
  pro: { bg: "bg-purple-500/20", text: "text-purple-300" },
};

/** Track-color tokens — same palette as PackHeatPicker so the merged
 *  Ultimate Qualifier grid feels visually consistent with mixed-track
 *  3-pack picking. */
const TRACK_BADGE: Record<string, { bg: string; text: string }> = {
  Red:  { bg: "bg-red-500/20",    text: "text-red-300" },
  Blue: { bg: "bg-blue-500/20",   text: "text-blue-300" },
  Mega: { bg: "bg-purple-500/20", text: "text-purple-300" },
};

/** Per-track theming for the WHOLE heat card — border + background
 *  tint + selected-state ring. Lets the customer scan the grid and
 *  immediately see which heats are Red vs. Blue without reading
 *  every badge. Mega keeps a neutral white treatment since single-
 *  track packages don't render a track badge anyway.
 *
 *  Disabled state intentionally DROPS the track tint and falls back
 *  to a flat dark-grey treatment — earlier we kept a low-opacity
 *  Red/Blue tint on locked cards and they blended visually with the
 *  active Red/Blue ones, making it hard to tell at a glance which
 *  heats were currently pickable. Neutral grey separates "available
 *  for this step" from "locked" cleanly regardless of track. */
const TRACK_CARD: Record<string, {
  base: string;       // unselected, interactive
  baseHover: string;
  selected: string;   // currently picked
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
    selected:  "border-amber-500 bg-amber-500/15 ring-1 ring-amber-500/50",
  },
};

/** Shared "locked" treatment — neutral grey, no track hint. Applied
 *  to any card that's currently uninteractive (other-step lock, gap-
 *  rule violation, conflict, low capacity, lead-time cutoff). Pairs
 *  with the per-track `base` palette: track tint = active for THIS
 *  step, grey = locked or unavailable.
 *
 *  Tuned aggressively dark (very low opacity + nearly invisible
 *  border) so locked cards recede well behind the active Red/Blue
 *  ones — earlier the locked treatment was still readable enough
 *  that customers had trouble distinguishing the two states. */
const DISABLED_CARD = "border-white/[0.04] bg-white/[0.015] opacity-30 cursor-not-allowed grayscale";

// ── Sub-components ──────────────────────────────────────────────────────────

function ProgressDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`w-2.5 h-2.5 rounded-full transition-colors ${
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

/**
 * Pills showing each filled component's pick, with X to clear.
 * Mirrors the AddOnsPage "Your Race Schedule" pill row.
 *
 * Clicking X clears that pick AND every later-sequence pick — a
 * Starter swap invalidates any Intermediate already locked in
 * (gap rule was anchored to the prior Starter's stop time).
 */
function SelectedHeats({
  picks,
  components,
  onClearFrom,
}: {
  picks: Record<string, PackagePick | null>;
  components: PackageRaceComponent[];
  onClearFrom: (ref: string) => void;
}) {
  const filled = components.filter((c) => picks[c.ref] != null);
  if (filled.length === 0) return null;
  return (
    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
      <p className="text-emerald-400 text-[10px] font-bold uppercase tracking-wider mb-2">
        Heats Selected
      </p>
      <div className="flex flex-wrap gap-2">
        {filled.map((c) => {
          const p = picks[c.ref]!;
          // Only show the track suffix on the pill when the
          // component spans multiple tracks (Red+Blue) — single-
          // track components (Mega-only or junior Blue-only) skip
          // the suffix to keep the pill compact.
          const trackSuffix = c.tracks.length > 1 ? ` ${p.trackOption.track}` : "";
          return (
            <span
              key={c.ref}
              className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold border border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
            >
              <span>🏎️ {c.label}{trackSuffix} · {formatTime(p.block.start)}</span>
              <button
                type="button"
                aria-label={`Clear ${c.label} selection`}
                onClick={() => onClearFrom(c.ref)}
                className="text-emerald-300/60 hover:text-red-400 transition-colors text-base leading-none -mr-1"
              >
                ×
              </button>
            </span>
          );
        })}
      </div>
      <p className="text-white/30 text-[10px] mt-1.5">
        Click × on a heat to swap it (later picks reset since the gap rule re-applies).
      </p>
    </div>
  );
}

function HeatGrid({
  proposals,
  components,
  picks,
  onToggle,
  quantity,
  bookedHeats,
  cutoff,
  currentComponent,
}: {
  proposals: TaggedProposal[];
  components: PackageRaceComponent[];
  picks: Record<string, PackagePick | null>;
  onToggle: (proposal: TaggedProposal, block: BmiBlock) => void;
  quantity: number;
  bookedHeats: { start: string; stop: string; track: string | null }[];
  cutoff: number;
  /** The component the user is currently filling. Cards from any
   *  other component are fully locked (no click, greyed) — to swap
   *  a prior pick, the user has to X its pill. Null when every
   *  component is already filled (no further picks accepted). */
  currentComponent: PackageRaceComponent | null;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
      {proposals.map((proposal, idx) => {
        const block = proposal.blocks?.[0]?.block;
        if (!block) return null;
        const blockStart = parseLocal(block.start).getTime();
        const component = components.find((c) => c.ref === proposal._componentRef);
        if (!component) return null;
        const tierBadge = TIER_BADGE[component.tier] ?? TIER_BADGE.starter;
        const trackBadge = TRACK_BADGE[proposal._track] ?? { bg: "bg-white/10", text: "text-white/70" };
        // Multi-track components show the Red/Blue badge in addition
        // to the tier badge so the customer can tell which track each
        // heat is on at a glance. Single-track components (Mega-only
        // or junior Blue-only) skip the badge — it would be redundant.
        const showTrackBadge = component.tracks.length > 1;

        const myPick = picks[component.ref];
        const isSelected = !!(myPick && myPick.proposal === proposal);

        // Hard lock — only the current step's component is
        // interactive. To change a prior pick, the user X's its
        // pill (clears that pick + later slots). Cards outside
        // the current step show a "Locked" status and can't be
        // clicked. This stops the previous trick where a Starter
        // swap mid-flow could leave an Intermediate violating the
        // gap rule unchecked.
        const isOtherStep = !!(currentComponent && currentComponent.ref !== component.ref);

        // Lead-time cutoff
        const tooSoon = cutoff > 0 && blockStart < cutoff;

        // Package gap rule against the referenced component's pick.
        const gapRule = component.minMinutesAfterEndOf;
        const refPick = gapRule ? picks[gapRule.ref] : null;
        const gapAnchor = refPick && gapRule
          ? { stop: refPick.block.stop, minutes: gapRule.minutes, refLabel: refPick.component.label }
          : null;
        const isGapViolation = gapAnchor
          ? violatesMinGapAfter(gapAnchor.stop, block.start, gapAnchor.minutes)
          : false;

        // Same/cross-track adjacency vs. EVERY pick from another
        // component + the external bookedHeats list. Uses the
        // proposal's own `_track` (not the component's primary
        // track) — multi-track components have heats on both Red
        // and Blue and the conflict math is per individual heat,
        // not per component slot.
        const otherPicks = Object.entries(picks)
          .filter(([ref, p]) => ref !== component.ref && p != null)
          .map(([, p]) => p as PackagePick);
        const isConflict =
          bookedHeats.some((bh) =>
            heatsConflict(parseLocal(bh.start).getTime(), bh.track, blockStart, proposal._track),
          ) ||
          otherPicks.some((p) =>
            heatsConflict(parseLocal(p.block.start).getTime(), p.trackOption.track, blockStart, proposal._track),
          );

        const isLowCap = block.freeSpots < quantity;
        // Selected heats stay clickable (the inner toggleHeat is a
        // no-op for selected = same heat re-clicked, which would
        // deselect — we don't want that mid-flow either since the
        // X-pill is the canonical "deselect" path now). Lock all
        // selected cards too.
        const isFull = isSelected
          ? true
          : (isOtherStep || isLowCap || isConflict || isGapViolation || tooSoon);

        const statusLabel = isSelected
          ? "Selected"
          : isOtherStep
            ? "Locked — finish the current step"
            : isGapViolation && gapAnchor
              ? `Available ${gapAnchor.minutes} min after ${gapAnchor.refLabel} ends`
              : isConflict
                ? "Too close to picked heat"
                : tooSoon
                  ? "Too soon — needs lead time"
                  : isLowCap
                    ? `Need ${quantity}, only ${block.freeSpots} left`
                    : spotsLabel(block.freeSpots, block.capacity).label;

        const statusClass = isSelected
          ? "text-emerald-300"
          : isOtherStep || isGapViolation || isConflict || tooSoon
            ? "text-amber-400"
            : isLowCap
              ? "text-red-400"
              : spotsLabel(block.freeSpots, block.capacity).text;

        const cardTooltip = isOtherStep
          ? "Locked — clear a heat above (×) to change it"
          : isGapViolation && gapAnchor
            ? packageGapTooltip(gapAnchor.minutes, gapAnchor.refLabel)
            : isConflict
              ? HEAT_CONFLICT_TOOLTIP
              : undefined;

        // Track-themed card colors — lets the customer scan Red vs.
        // Blue at a glance instead of having to read every badge.
        // Mega and unknown tracks fall back to the neutral palette.
        // Disabled cards drop the track tint entirely (see comment
        // on TRACK_CARD): grey = locked, track-tinted = active for
        // the current step.
        const trackTheme = TRACK_CARD[proposal._track] ?? TRACK_CARD.Mega;
        const cardClass = isSelected
          ? trackTheme.selected
          : isFull
            ? DISABLED_CARD
            : `${trackTheme.base} ${trackTheme.baseHover} cursor-pointer`;

        return (
          <button
            key={idx}
            type="button"
            onClick={() => !isFull && onToggle(proposal, block)}
            disabled={isFull}
            title={cardTooltip}
            className={`rounded-xl border p-3 text-left transition-all duration-150 ${cardClass}`}
          >
            {/* Tier + track badges. Tier tells the customer which
                slot this heat fills (Starter vs. Intermediate); the
                track badge (Red/Blue) only renders for multi-track
                components so the customer can mix tracks freely. */}
            <div className="flex items-center gap-1 flex-wrap mb-1.5">
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${tierBadge.bg} ${tierBadge.text}`}>
                {component.tier}
              </span>
              {showTrackBadge && (
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${trackBadge.bg} ${trackBadge.text}`}>
                  {proposal._track}
                </span>
              )}
            </div>
            <div className="text-white font-bold text-base mb-2">{formatTime(block.start)}</div>
            <div className="text-xs font-medium mb-1 text-white/60">{block.name}</div>
            <div className={`text-[13px] font-medium ${statusClass}`}>
              {statusLabel}
            </div>
            <div className="mt-2 h-1 rounded-full bg-white/10 overflow-hidden">
              <div
                className={`h-full rounded-full ${isLowCap ? "bg-red-500" : (isConflict || isGapViolation || isOtherStep) ? "bg-amber-400/50" : block.freeSpots / block.capacity <= 0.3 ? "bg-amber-400" : "bg-emerald-400"}`}
                style={{ width: (isConflict || isGapViolation || isOtherStep) ? "100%" : `${(block.freeSpots / block.capacity) * 100}%` }}
              />
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export default function PackageHeatPicker({
  pkg,
  date,
  quantity,
  bookedHeats = [],
  minAdvanceMinutes = 0,
  onConfirm,
  onBack,
}: PackageHeatPickerProps) {
  const components = useMemo(
    () => [...pkg.races].sort((a, b) => a.sequence - b.sequence),
    [pkg],
  );
  const totalComponents = components.length;
  const ctaRef = useRef<HTMLDivElement>(null);

  const [picks, setPicks] = useState<Record<string, PackagePick | null>>(() => {
    const seed: Record<string, PackagePick | null> = {};
    for (const c of components) seed[c.ref] = null;
    return seed;
  });
  const [proposals, setProposals] = useState<TaggedProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Lead-time cutoff anchored at mount — Date.now() is impure in
  // render under our ESLint config.
  const cutoff = useMemo(
    () => (minAdvanceMinutes > 0 ? Date.now() + minAdvanceMinutes * 60_000 : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Fetch heats for every component AND every track in parallel and
  // merge into ONE tagged list. Each proposal carries `_componentRef`
  // (which slot it fills) and `_track` (which BMI productId it should
  // book against). Multi-track components fan out to two fetches —
  // one per track — so the customer sees both Red and Blue heats in
  // a single chronological grid.
  const fetchHeats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const dateOnly = date.split("T")[0];
      // Build one fetch task per (component, track). De-dup by
      // (componentRef, track, start) so overlapping fetches don't
      // double-count.
      const fetchTasks: Array<{ component: PackageRaceComponent; track: PackageTrackOption }> = [];
      for (const c of components) {
        for (const t of c.tracks) fetchTasks.push({ component: c, track: t });
      }
      const seen = new Set<string>();
      const fetches = fetchTasks.map(async ({ component, track }) => {
        const data = await bmiPost(
          "availability",
          {
            ProductId: Number(track.productId),
            PageId: Number(track.pageId),
            Quantity: 1,
            OrderId: null,
            PersonId: null,
            DynamicLines: [],
          },
          { date: dateOnly },
        );
        const props: BmiProposal[] = data?.proposals || [];
        const out: TaggedProposal[] = [];
        for (const p of props) {
          const start = p.blocks?.[0]?.block?.start;
          const key = start ? `${component.ref}|${track.track}|${start}` : "";
          if (key && !seen.has(key)) {
            seen.add(key);
            out.push({ ...p, _componentRef: component.ref, _track: track.track } as TaggedProposal);
          }
        }
        return out;
      });
      const all = (await Promise.all(fetches)).flat();
      // Sort by start time so the grid reads top-to-bottom
      // chronologically. Tier + track badges keep cards visually
      // distinct in the merged grid.
      all.sort((a, b) => {
        const aS = a.blocks?.[0]?.block?.start || "";
        const bS = b.blocks?.[0]?.block?.start || "";
        return aS.localeCompare(bS);
      });
      setProposals(all);
    } catch {
      setError("Couldn't load time slots. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [components, date]);

  useEffect(() => { fetchHeats(); }, [fetchHeats]);

  // Auto-scroll the CTA when the user fills in the last pick.
  const pickedCount = components.filter((c) => picks[c.ref] != null).length;
  const allPicked = pickedCount === totalComponents;
  useEffect(() => {
    if (allPicked) {
      setTimeout(() => ctaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
  }, [allPicked]);

  /** Set the pick for the heat's component. Resolves the chosen
   *  track option from the component's `tracks` list — this is what
   *  the booking call later uses to pick the right BMI productId
   *  (Red Starter vs. Blue Starter live on different SKUs).
   *
   *  Does NOT auto-deselect on second click — selected heats are
   *  locked in the grid (see HeatGrid `isSelected` branch) and the
   *  canonical clear path is the pill X above the grid (which also
   *  clears later picks). */
  function setHeat(proposal: TaggedProposal, block: BmiBlock) {
    const component = components.find((c) => c.ref === proposal._componentRef);
    if (!component) return;
    const trackOption = component.tracks.find((t) => t.track === proposal._track);
    if (!trackOption) return;
    setPicks((prev) => ({
      ...prev,
      [component.ref]: { component, trackOption, proposal, block },
    }));
  }

  /** Clear the pick for `ref` AND every later-sequence component.
   *  A Starter swap invalidates an Intermediate already locked in
   *  (the gap rule was anchored on the prior Starter's stop time),
   *  so we conservatively reset everything from `ref` forward and
   *  send the user back through the affected steps. */
  function clearPickAndLater(ref: string) {
    const target = components.find((c) => c.ref === ref);
    if (!target) return;
    setPicks((prev) => {
      const next: Record<string, PackagePick | null> = { ...prev };
      for (const c of components) {
        if (c.sequence >= target.sequence) next[c.ref] = null;
      }
      return next;
    });
  }

  // The component the user is currently filling — first un-picked
  // by sequence. Null when every slot is filled.
  const currentComponent =
    components
      .filter((c) => !picks[c.ref])
      .sort((a, b) => a.sequence - b.sequence)[0] ?? null;

  const displayDate = parseLocal(date + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Header — package name + race count. Mirrors PackHeatPicker's
          "Pick {totalRaces} heats — $X.XX total" line. */}
      <div className="text-center">
        <p className="text-amber-400 text-[11px] font-bold uppercase tracking-widest mb-1">
          {pkg.name}
        </p>
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-1">
          Pick Your Heats
        </h2>
        <p className="text-white/50 text-sm">
          {displayDate} · Pick {totalComponents} heat{totalComponents === 1 ? "" : "s"}
        </p>
      </div>

      <ProgressDots current={pickedCount} total={totalComponents} />

      {/* Current-step banner — names the slot the user is filling
          NEXT, or confirms when every slot has a pick. Pairs with
          the grid's hard lock (only `currentComponent`'s cards are
          interactive) so the customer always knows what to click. */}
      {currentComponent ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-4 py-2 text-center">
          <p className="text-amber-300 text-xs font-bold uppercase tracking-widest">
            Step {currentComponent.sequence} of {totalComponents} · Pick your {currentComponent.label}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] px-4 py-2 text-center">
          <p className="text-emerald-300 text-xs font-bold uppercase tracking-widest">
            All heats selected — review and confirm below
          </p>
        </div>
      )}

      {/* Track context — shown only when the current step has both
          Red and Blue available. Helps the customer understand the
          color-coded heat cards below ("which one do I want?")
          before they pick. Single-track components (Mega-only or
          junior Blue-only) hide this since there's no choice. */}
      {currentComponent && currentComponent.tracks.length > 1 && (
        <TrackInfoBanner tracks={currentComponent.tracks.map((t) => t.track)} />
      )}

      <SelectedHeats picks={picks} components={components} onClearFrom={clearPickAndLater} />

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
          <p className="text-white/40 text-sm">No heats available for this date.</p>
        </div>
      ) : (
        <>
          <HeatGrid
            proposals={proposals}
            components={components}
            picks={picks}
            onToggle={setHeat}
            quantity={quantity}
            bookedHeats={bookedHeats}
            cutoff={cutoff}
            currentComponent={currentComponent}
          />

          <div
            ref={ctaRef}
            className={`rounded-xl border p-5 transition-all duration-300 ${
              allPicked
                ? "border-amber-500/40 bg-amber-500/8"
                : "border-white/10 bg-white/3"
            }`}
          >
            {allPicked ? (
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <p className="text-white/50 text-xs mb-1">All {totalComponents} heats selected</p>
                  <p className="text-white/70 text-sm">
                    {components.map((c) => {
                      const pick = picks[c.ref]!;
                      const trackSuffix = c.tracks.length > 1 ? ` ${pick.trackOption.track}` : "";
                      return `${c.label}${trackSuffix} · ${formatTime(pick.block.start)}`;
                    }).join(" → ")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    onConfirm({
                      picks: components
                        .map((c) => picks[c.ref])
                        .filter((p): p is PackagePick => p != null),
                    })
                  }
                  className="shrink-0 inline-flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-sm bg-amber-400 text-[#000418] hover:bg-amber-300 transition-colors shadow-lg shadow-amber-500/25"
                >
                  Confirm &amp; Continue to Checkout →
                </button>
              </div>
            ) : (
              <p className="text-center text-white/40 text-sm">
                Selected <span className="text-white font-bold">{pickedCount}</span> of <span className="text-white font-bold">{totalComponents}</span> heats
              </p>
            )}
          </div>
        </>
      )}

      <button onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors">
        ← Change package
      </button>
    </div>
  );
}

export type { BmiProduct };
