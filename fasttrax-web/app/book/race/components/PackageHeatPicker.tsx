"use client";

import { useState } from "react";
import HeatPicker from "./HeatPicker";
import type { ClassifiedProduct, BmiProposal, BmiBlock, BmiProduct } from "../data";
import type { PackageDefinition, PackageRaceComponent } from "@/lib/packages";

/**
 * Multi-component sequential heat picker for packages with more
 * than one race (e.g. Ultimate Qualifier — Starter Mega → Intermediate
 * Mega ≥ 60 min later).
 *
 * Wraps the existing single-race `HeatPicker` once per
 * `PackageRaceComponent`, advancing through them in `sequence`
 * order. Per-component cross-rules (`minMinutesAfterEndOf`) are
 * forwarded to the inner picker via its `minutesAfterEnd` prop so
 * blocked heats render the package-specific tooltip.
 *
 * Multi-racer behavior matches the user's "all share heats" choice
 * for Ultimate Qualifier — `quantity` is the racer count and gets
 * passed through to each inner picker, so the same N seats are
 * reserved on every component's heat.
 *
 * Picks are kept in local state until ALL components are filled.
 * Then `onConfirm` fires with the full pick list. The outer page
 * is responsible for the actual BMI booking — this picker just
 * gathers selections.
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
   *  "must arrive 75 min early" rule). Forwarded to the inner picker. */
  minAdvanceMinutes?: number;
  onConfirm: (result: { picks: PackagePick[] }) => void;
  onBack: () => void;
}

/** Synthesize a minimal `ClassifiedProduct` from a package race
 *  component so the inner `HeatPicker` (which expects that shape)
 *  can call BMI's /availability endpoint and render correctly.
 *  Most ClassifiedProduct fields aren't read by the picker — only
 *  productId / pageId / name / tier / track / price matter. */
function componentToRace(c: PackageRaceComponent): ClassifiedProduct {
  return {
    productId: c.productId,
    pageId: c.pageId,
    name: c.label,
    tier: c.tier,
    category: "adult",
    track: c.track,
    price: c.price,
    isCombo: false,
    packType: "none",
    raceCount: 1,
    sessionGroup: "",
    raw: {} as BmiProduct,
  };
}

export default function PackageHeatPicker({
  pkg,
  date,
  quantity,
  bookedHeats = [],
  minAdvanceMinutes = 0,
  onConfirm,
  onBack,
}: PackageHeatPickerProps) {
  // Components in sequence order — Starter (1) before Intermediate (2)
  const components = [...pkg.races].sort((a, b) => a.sequence - b.sequence);
  const total = components.length;

  // Picks indexed by sequence-1 (so picks[0] is the first component).
  // null = not yet picked.
  const [picks, setPicks] = useState<Array<PackagePick | null>>(() => components.map(() => null));
  // Which component the user is actively picking. Defaults to the
  // first un-picked one. Clicking a breadcrumb above sends them back.
  const [currentIdx, setCurrentIdx] = useState<number>(0);

  const currentComponent = components[currentIdx];

  // Resolve the gap rule for the current component, if any. The
  // referenced component's pick must already exist for the rule to
  // apply — if the user jumps back and re-picks an earlier component,
  // a later component's gap is still validated when they advance.
  const minutesAfterEnd: { stop: string; minutes: number; refLabel: string } | undefined = (() => {
    const rule = currentComponent?.minMinutesAfterEndOf;
    if (!rule) return undefined;
    const refIdx = components.findIndex((c) => c.ref === rule.ref);
    const refPick = refIdx >= 0 ? picks[refIdx] : null;
    if (!refPick) return undefined; // no anchor yet; rule effectively inert
    return {
      stop: refPick.block.stop,
      minutes: rule.minutes,
      refLabel: refPick.component.label.replace(/^Starter Race\s+/i, "").replace(/Race\s+/i, "") + " ends",
    };
  })();

  // Augment bookedHeats with any picks the user has already made for
  // this package, so the inner HeatPicker's same/cross-track rules
  // also apply (a chosen Starter Mega heat blocks an adjacent
  // Intermediate Mega heat, etc.). The package gap rule above
  // handles the broader "≥ 60 min" constraint separately.
  const augmentedBookedHeats = [
    ...bookedHeats,
    ...picks
      .map((p, i) => (i === currentIdx ? null : p))
      .filter((p): p is PackagePick => p != null)
      .map((p) => ({ start: p.block.start, stop: p.block.stop, track: p.component.track })),
  ];

  function handleInnerConfirm(proposal: BmiProposal, block: BmiBlock) {
    const next = [...picks];
    next[currentIdx] = { component: currentComponent, proposal, block };
    setPicks(next);

    // Find the next un-picked component AFTER the current one.
    // If everything's filled, fire onConfirm. If a later component
    // exists but is still un-picked, advance there. Otherwise we're
    // done (user re-picked an earlier component but later ones were
    // already filled — fall through to confirmation).
    const nextEmptyAfter = next.findIndex((p, i) => i > currentIdx && p == null);
    if (nextEmptyAfter >= 0) {
      setCurrentIdx(nextEmptyAfter);
      return;
    }
    // All filled → emit. Filter out nulls (typescript nudge — the
    // findIndex above guarantees none remain).
    const allFilled = next.every((p): p is PackagePick => p != null);
    if (allFilled) {
      onConfirm({ picks: next as PackagePick[] });
    } else {
      // Find any remaining gap — could be earlier than currentIdx
      const anyEmpty = next.findIndex((p) => p == null);
      setCurrentIdx(anyEmpty >= 0 ? anyEmpty : currentIdx);
    }
  }

  // Mocked onQuantityChange / onAddAnother — package quantity is set
  // by the outer page (per-package racer count); we don't allow
  // changing it inside an individual component's picker.
  const noop = () => {};

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      {/* Header — package name + step indicator */}
      <div className="text-center space-y-1">
        <p className="text-amber-400 text-[11px] font-bold uppercase tracking-widest">
          {pkg.name}
        </p>
        <h2 className="text-2xl font-display uppercase tracking-widest text-white">
          Pick Your Heats
        </h2>
        <p className="text-white/50 text-sm">
          Step {currentIdx + 1} of {total} · {currentComponent.label}
        </p>
      </div>

      {/* Breadcrumb tabs — click to revisit a step. Steps after
          un-picked ones are locked. */}
      <div className="flex items-stretch gap-2">
        {components.map((c, i) => {
          const pick = picks[i];
          const isCurrent = i === currentIdx;
          const isLocked = i > currentIdx && picks.slice(0, i).some((p) => p == null);
          return (
            <button
              key={c.ref}
              type="button"
              onClick={() => {
                if (isLocked) return;
                setCurrentIdx(i);
              }}
              disabled={isLocked}
              className={`flex-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                isCurrent
                  ? "border-[#00E2E5]/60 bg-[#00E2E5]/10"
                  : isLocked
                    ? "border-white/5 bg-white/[0.02] opacity-40 cursor-not-allowed"
                    : "border-white/15 bg-white/5 hover:border-white/25"
              }`}
            >
              <p className="text-[10px] uppercase tracking-widest text-white/40">
                Step {i + 1}
              </p>
              <p className="text-white text-sm font-semibold truncate">{c.label}</p>
              {pick ? (
                <p className="text-emerald-400 text-xs mt-0.5">
                  ✓ {new Date(pick.block.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                </p>
              ) : (
                <p className="text-white/30 text-xs mt-0.5">Not picked</p>
              )}
            </button>
          );
        })}
      </div>

      {/* Inner HeatPicker for the current component. Re-mounted on
          component change via key so its internal "selected heat"
          state resets cleanly between steps. */}
      <HeatPicker
        key={currentComponent.ref}
        race={componentToRace(currentComponent)}
        date={date}
        quantity={quantity}
        onQuantityChange={noop}
        onConfirm={handleInnerConfirm}
        onBack={() => {
          // If we're on step 1 → exit the package entirely. Else go
          // back to the previous step so the user can re-pick.
          if (currentIdx === 0) {
            onBack();
            return;
          }
          setCurrentIdx(currentIdx - 1);
        }}
        confirmLabel={
          currentIdx + 1 < total
            ? `Continue to ${components[currentIdx + 1].label} →`
            : "Lock in heats →"
        }
        bookedHeats={augmentedBookedHeats}
        minAdvanceMinutes={minAdvanceMinutes}
        minutesAfterEnd={minutesAfterEnd}
      />
    </div>
  );
}
