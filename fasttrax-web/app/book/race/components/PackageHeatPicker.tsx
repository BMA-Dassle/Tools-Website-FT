"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { BmiProposal, BmiBlock, BmiProduct } from "../data";
import { bmiPost } from "../data";
import type { PackageDefinition, PackageRaceComponent } from "@/lib/packages";
import {
  heatsConflict,
  HEAT_CONFLICT_TOOLTIP,
  violatesMinGapAfter,
  packageGapTooltip,
} from "@/lib/heat-conflict";

/**
 * Multi-component heat picker for packages with more than one race
 * (Ultimate Qualifier — Starter Mega → Intermediate Mega ≥ 60 min
 * later). Mirrors the race-pack PackHeatPicker UX so customers
 * already familiar with that flow see the same single-screen
 * pattern: every component's heats laid out at once, one selection
 * per component, single commit button at the bottom.
 *
 * vs. PackHeatPicker:
 *   - Sections by component (Starter, Intermediate) instead of one
 *     merged grid — clearer when the same time on different tiers
 *     is meaningful.
 *   - Per-component cross-rules: package's `minMinutesAfterEndOf`
 *     gap (e.g. Intermediate ≥ 60 min after Starter ends) plus
 *     standard same/cross-track adjacency from `lib/heat-conflict`.
 *   - Multi-racer "all share heats" — `quantity` reserves N seats
 *     on each chosen heat.
 *
 * Outputs the same `{ picks: PackagePick[] }` shape the parent
 * page.tsx expects so handlePackageHeatsConfirm doesn't change.
 */

export interface PackagePick {
  component: PackageRaceComponent;
  proposal: BmiProposal;
  block: BmiBlock;
}

interface PackageHeatPickerProps {
  pkg: PackageDefinition;
  date: string;          // YYYY-MM-DD
  quantity: number;      // racer count
  /** Other heats already in the cart (cross-track / cross-day). */
  bookedHeats?: { start: string; stop: string; track: string | null }[];
  /** Minimum lead time before a heat can be booked (e.g. new-racer
   *  "must arrive 75 min early" rule). Forwarded to all components. */
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

// ── Component ───────────────────────────────────────────────────────────────

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

  // Picks indexed by component.ref. null = not yet chosen.
  const [picks, setPicks] = useState<Record<string, PackagePick | null>>(() => {
    const seed: Record<string, PackagePick | null> = {};
    for (const c of components) seed[c.ref] = null;
    return seed;
  });

  // Per-component proposals fetched from BMI on mount.
  const [proposalsByRef, setProposalsByRef] = useState<Record<string, BmiProposal[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ctaRef = useRef<HTMLDivElement>(null);

  // Fetch availability for every component in parallel — one
  // /api/bmi?endpoint=availability call per productId. BMI's
  // current proxy returns the full day in one shot.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const dateOnly = date.split("T")[0];
        const fetches = components.map(async (c) => {
          const data = await bmiPost(
            "availability",
            {
              ProductId: Number(c.productId),
              PageId: Number(c.pageId),
              Quantity: 1,
              OrderId: null,
              PersonId: null,
              DynamicLines: [],
            },
            { date: dateOnly },
          );
          const proposals: BmiProposal[] = data?.proposals || [];
          proposals.sort((a, b) => {
            const aS = a.blocks?.[0]?.block?.start || "";
            const bS = b.blocks?.[0]?.block?.start || "";
            return aS.localeCompare(bS);
          });
          return [c.ref, proposals] as const;
        });
        const results = await Promise.all(fetches);
        if (cancelled) return;
        const next: Record<string, BmiProposal[]> = {};
        for (const [ref, props] of results) next[ref] = props;
        setProposalsByRef(next);
      } catch {
        if (!cancelled) setError("Couldn't load time slots. Please try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [components, date]);

  // Auto-scroll the CTA into view when all picks are filled.
  useEffect(() => {
    const allPicked = components.every((c) => picks[c.ref] != null);
    if (allPicked) {
      setTimeout(() => ctaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
  }, [picks, components]);

  function pickHeat(component: PackageRaceComponent, proposal: BmiProposal, block: BmiBlock) {
    setPicks((prev) => ({
      ...prev,
      [component.ref]: { component, proposal, block },
    }));
  }

  function clearPick(ref: string) {
    setPicks((prev) => ({ ...prev, [ref]: null }));
  }

  const allPicked = components.every((c) => picks[c.ref] != null);
  const pickedCount = components.filter((c) => picks[c.ref] != null).length;

  const displayDate = parseLocal(date + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="text-center space-y-1">
        <p className="text-amber-400 text-[11px] font-bold uppercase tracking-widest">
          {pkg.name}
        </p>
        <h2 className="text-2xl font-display uppercase tracking-widest text-white">
          Pick Your Heats
        </h2>
        <p className="text-white/50 text-sm">
          {displayDate} · Pick {totalComponents} heat{totalComponents === 1 ? "" : "s"}
        </p>
      </div>

      {/* Progress dots — visual cue of how many picks are in. */}
      <div className="flex items-center justify-center gap-2">
        {components.map((c, i) => {
          const filled = picks[c.ref] != null;
          return (
            <div
              key={c.ref}
              className={`flex items-center gap-2 ${i > 0 ? "ml-2" : ""}`}
            >
              <div
                className={`w-2.5 h-2.5 rounded-full transition-colors ${
                  filled ? "bg-amber-400" : "bg-white/15"
                }`}
              />
              <span
                className={`text-[11px] uppercase tracking-widest ${
                  filled ? "text-amber-400" : "text-white/30"
                }`}
              >
                {c.label.replace(/^Starter Race\s+|^Intermediate Race\s+|^Pro Race\s+/i, "")}
              </span>
            </div>
          );
        })}
      </div>

      {loading ? (
        <div className="h-48 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-white/20 border-t-white/80 rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="h-48 flex flex-col items-center justify-center gap-3">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      ) : (
        <div className="space-y-8">
          {components.map((component) => (
            <ComponentSection
              key={component.ref}
              component={component}
              proposals={proposalsByRef[component.ref] || []}
              picks={picks}
              quantity={quantity}
              bookedHeats={bookedHeats}
              minAdvanceMinutes={minAdvanceMinutes}
              onPick={(p, b) => pickHeat(component, p, b)}
              onClear={() => clearPick(component.ref)}
            />
          ))}

          {/* Commit CTA */}
          <div
            ref={ctaRef}
            className={`rounded-xl border p-5 transition-all duration-300 ${
              allPicked
                ? "border-[#00E2E5]/40 bg-[#00E2E5]/8"
                : "border-white/10 bg-white/3"
            }`}
          >
            {allPicked ? (
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <p className="text-white/50 text-xs mb-1">All {totalComponents} heats selected</p>
                  <p className="text-white/70 text-sm">
                    {components
                      .map((c) => `${c.label} · ${formatTime(picks[c.ref]!.block.start)}`)
                      .join(" → ")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    onConfirm({
                      picks: components.map((c) => picks[c.ref]!).filter((p): p is PackagePick => p != null),
                    })
                  }
                  className="shrink-0 inline-flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25"
                >
                  Lock in heats →
                </button>
              </div>
            ) : (
              <p className="text-center text-white/40 text-sm">
                Selected <span className="text-white font-bold">{pickedCount}</span> of <span className="text-white font-bold">{totalComponents}</span> heats
              </p>
            )}
          </div>
        </div>
      )}

      <button onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors">
        ← Change package
      </button>
    </div>
  );
}

// ── Component section ──────────────────────────────────────────────────────

function ComponentSection({
  component,
  proposals,
  picks,
  quantity,
  bookedHeats,
  minAdvanceMinutes,
  onPick,
  onClear,
}: {
  component: PackageRaceComponent;
  proposals: BmiProposal[];
  picks: Record<string, PackagePick | null>;
  quantity: number;
  bookedHeats: { start: string; stop: string; track: string | null }[];
  minAdvanceMinutes: number;
  onPick: (proposal: BmiProposal, block: BmiBlock) => void;
  onClear: () => void;
}) {
  const myPick = picks[component.ref];

  // Gap rule: when this component declares a `minMinutesAfterEndOf`,
  // any candidate heat must start ≥ N minutes after the referenced
  // component's chosen heat ENDS. If the referenced component isn't
  // picked yet, the rule is inert (no candidates blocked) — but the
  // section header tells the user to pick that one first.
  const gapRule = component.minMinutesAfterEndOf;
  const refPick = gapRule ? picks[gapRule.ref] : null;
  const gapAnchor = refPick && gapRule ? { stop: refPick.block.stop, minutes: gapRule.minutes, refLabel: refPick.component.label } : null;

  // Same-time picks from OTHER components in the package — used to
  // run standard same-track / cross-track adjacency conflict so we
  // don't accidentally book two heats that overlap or are too close
  // for the racer to walk between.
  const otherPicks = Object.entries(picks)
    .filter(([ref, p]) => ref !== component.ref && p != null)
    .map(([, p]) => p as PackagePick);

  // Lead-time cutoff — anchored at component mount so re-renders
  // don't shift it. `Date.now()` is impure in render under our
  // ESLint config; useMemo + empty deps locks it down.
  const cutoff = useMemo(
    () => (minAdvanceMinutes > 0 ? Date.now() + minAdvanceMinutes * 60_000 : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <h3 className="text-white font-bold text-base">{component.label}</h3>
          {gapRule && !refPick && (
            <p className="text-amber-400/70 text-xs mt-0.5">
              Pick your {gapRule.ref} heat first to see options here.
            </p>
          )}
        </div>
        {myPick && (
          <button
            type="button"
            onClick={onClear}
            className="text-white/40 hover:text-white/70 text-xs underline"
          >
            Clear
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
        {proposals.map((proposal, idx) => {
          const block = proposal.blocks?.[0]?.block;
          if (!block) return null;
          const blockStart = parseLocal(block.start).getTime();

          // Lead-time cutoff (new-racer 75-min rule etc.)
          const tooSoon = cutoff > 0 && blockStart < cutoff;

          // Gap rule against the referenced component's pick.
          const isGapViolation = gapAnchor
            ? violatesMinGapAfter(gapAnchor.stop, block.start, gapAnchor.minutes)
            : false;

          // Same/cross-track adjacency conflict against:
          //  - heats already in the customer's cart (cross-day, etc.)
          //  - sibling-component picks within this package
          const isConflict =
            bookedHeats.some((bh) =>
              heatsConflict(parseLocal(bh.start).getTime(), bh.track, blockStart, component.track),
            ) ||
            otherPicks.some((p) =>
              heatsConflict(parseLocal(p.block.start).getTime(), p.component.track, blockStart, component.track),
            );

          const isLowCap = block.freeSpots < quantity;
          const isFull = isLowCap || isConflict || isGapViolation || tooSoon;
          const isSelected = !!(myPick && myPick.proposal === proposal);

          const statusLabel = isGapViolation && gapAnchor
            ? `Available ${gapAnchor.minutes} min after ${gapAnchor.refLabel} ends`
            : isConflict
              ? "Too close to picked heat"
              : tooSoon
                ? "Too soon — needs lead time"
                : isLowCap
                  ? `Need ${quantity}, only ${block.freeSpots} left`
                  : spotsLabel(block.freeSpots, block.capacity).label;

          const statusClass = isGapViolation || isConflict || tooSoon
            ? "text-amber-400"
            : isLowCap
              ? "text-red-400"
              : spotsLabel(block.freeSpots, block.capacity).text;

          const cardTooltip = isGapViolation && gapAnchor
            ? packageGapTooltip(gapAnchor.minutes, gapAnchor.refLabel)
            : isConflict
              ? HEAT_CONFLICT_TOOLTIP
              : undefined;

          return (
            <button
              key={idx}
              type="button"
              onClick={() => {
                if (isFull) return;
                onPick(proposal, block);
              }}
              disabled={isFull}
              title={cardTooltip}
              className={`rounded-xl border p-3 text-left transition-all duration-150 ${
                isSelected
                  ? "border-amber-500 bg-amber-500/15 ring-1 ring-amber-500/50"
                  : isFull
                    ? "border-white/5 bg-white/3 opacity-40 cursor-not-allowed"
                    : "border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10 cursor-pointer"
              }`}
            >
              <div className="text-white font-bold text-base mb-0.5">{formatTime(block.start)}</div>
              <div className="text-white/40 text-xs mb-2">→ {formatTime(block.stop)}</div>
              <div className="text-xs font-medium mb-1 text-white/60">{block.name}</div>
              <div className={`text-[13px] font-medium ${statusClass}`}>
                {statusLabel}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// Re-export types used by callers — lets page.tsx import
// `PackagePick` from here without reaching into lib/packages.
export type { BmiProduct };
