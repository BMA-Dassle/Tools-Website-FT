/**
 * Package pick derivation — the package heat picker's picks are DERIVED from
 * `item.heats` (the cart is the source of truth), not component state. That is
 * what lets package picks hold-as-you-tap like the single-race grid (owner
 * 2026-07-19: "we confirm them as we're selecting races, why is this
 * different") — there is no local picks Map to "confirm" into the cart, so the
 * v1-era Confirm & Continue step and the Heats Selected interstitial are gone,
 * and back-nav re-renders the live grid with picks intact for free.
 *
 * Pure module (no React) so the mapping, the wizard's advance gate, and the
 * roster diffing are unit-testable.
 */
import type { PackageRaceComponent } from "@/lib/packages";
import type { RaceHeatAssignment } from "../state/types";

/** Minimal proposal shape the derivation needs — flattened from the picker's
 *  availability queries. */
export interface PackageProposalLite {
  productId: string;
  track: string | null;
  start: string;
  stop: string;
}

/** A committed (held-in-cart) pick for one package component. */
export interface CommittedPick {
  componentRef: string;
  productId: string;
  track: string | null;
  /** Heat start (== heat.heatId). */
  start: string;
  /** Heat stop — resolved from the fetched proposals; estimated when the held
   *  slot is no longer in the grid (see FALLBACK_HEAT_MINUTES). */
  stop: string;
  /** True when `stop` was estimated. The gap rule then degrades CONSERVATIVE
   *  (a too-long stop can only push the next race later, never earlier) —
   *  assertHeatBookable stays authoritative server-side. */
  synthesized: boolean;
}

/** Estimated heat length when the held slot's proposal is missing from the
 *  fetched grid (restriction hide-rule, availability hiccup). 20 min is ≥ any
 *  real heat length, so the gap rule can only get stricter. */
export const FALLBACK_HEAT_MINUTES = 20;

/** "2026-07-19T15:00:00.000Z" → "2026-07-19T15:00:00" (naive center-local). */
function normalizeStart(iso: string): string {
  return iso.replace(/\.\d+/, "").replace(/Z$/, "");
}

function sameStart(a: string, b: string): boolean {
  return normalizeStart(a) === normalizeStart(b);
}

function sameTrack(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = (a ?? "").trim().toLowerCase();
  const nb = (b ?? "").trim().toLowerCase();
  return na !== "" && na === nb;
}

/** Naive local ISO + minutes → naive local ISO (no timezone math). */
function addMinutesLocal(iso: string, minutes: number): string {
  const d = new Date(normalizeStart(iso));
  d.setMinutes(d.getMinutes() + minutes);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

/**
 * Reconstruct the per-component picks from the cart's heats.
 *
 * Scope: this CATEGORY's heats on THIS package's component SKUs — the other
 * category's package (mixed party — distinct SKUs, `category` backstop) and
 * single-race heats accumulated via "Add another race" never leak in. Multiple
 * racers share one physical pick, so components dedupe by (productId, start)
 * — the same pick identity as the grid cards.
 */
export function derivePackagePicks(
  pkg: { races: PackageRaceComponent[] },
  heats: RaceHeatAssignment[],
  category: "adult" | "junior",
  proposals: PackageProposalLite[],
): Map<string, CommittedPick> {
  const picks = new Map<string, CommittedPick>();
  for (const comp of [...pkg.races].sort((a, b) => a.sequence - b.sequence)) {
    const compProductIds = new Set(comp.tracks.map((t) => t.productId));
    const heat = heats.find(
      (h) =>
        !!h.heatId &&
        (h.category ?? "adult") === category &&
        !!h.productId &&
        compProductIds.has(h.productId),
    );
    if (!heat?.heatId || !heat.productId) continue;
    const matched =
      proposals.find((p) => p.productId === heat.productId && sameStart(p.start, heat.heatId!)) ??
      proposals.find((p) => sameTrack(p.track, heat.track) && sameStart(p.start, heat.heatId!));
    picks.set(comp.ref, {
      componentRef: comp.ref,
      productId: heat.productId,
      track: heat.track,
      start: heat.heatId,
      stop: matched?.stop ?? addMinutesLocal(heat.heatId, FALLBACK_HEAT_MINUTES),
      synthesized: !matched,
    });
  }
  return picks;
}

/**
 * The wizard's advance gate: EVERY package component needs ≥1 heat assigned to
 * one of this category's racers. (The old any-heat check was safe only while
 * heats appeared all-at-once at Confirm; with incremental tap-to-hold writes it
 * would let Continue pass with just the Starter picked.)
 */
export function packageComponentsCovered(
  pkg: { races: PackageRaceComponent[] },
  heats: RaceHeatAssignment[],
  categoryRacerIds: Set<string>,
): { covered: boolean; missing: PackageRaceComponent[] } {
  const missing = [...pkg.races]
    .sort((a, b) => a.sequence - b.sequence)
    .filter((comp) => {
      const ids = new Set(comp.tracks.map((t) => t.productId));
      return !heats.some(
        (h) =>
          !!h.heatId &&
          !!h.assignedTo &&
          categoryRacerIds.has(h.assignedTo) &&
          !!h.productId &&
          ids.has(h.productId),
      );
    });
  return { covered: missing.length === 0, missing };
}

/**
 * Heat additions/removals when the roster checklist toggles a member AFTER
 * picks are held. Per-line holds make this safe: each racer's heat is its own
 * BMI line, so one member's sync never touches another's.
 *
 * toAdd is built in COMPONENT SEQUENCE order — `licenseHeatIndices` licenses a
 * new racer's FIRST heat in array order, and appending Starter-before-
 * Intermediate keeps that first heat the Starter.
 */
export function rosterSyncPlan(args: {
  memberId: string;
  nowIncluded: boolean;
  pkg: { races: PackageRaceComponent[] };
  category: "adult" | "junior";
  heats: RaceHeatAssignment[];
  picks: Map<string, CommittedPick>;
}): { toAdd: RaceHeatAssignment[]; toRemove: RaceHeatAssignment[] } {
  const { memberId, nowIncluded, pkg, category, heats, picks } = args;
  const pkgProductIds = new Set(pkg.races.flatMap((c) => c.tracks.map((t) => t.productId)));
  if (!nowIncluded) {
    return {
      toAdd: [],
      toRemove: heats.filter(
        (h) =>
          h.assignedTo === memberId &&
          (h.category ?? "adult") === category &&
          !!h.productId &&
          pkgProductIds.has(h.productId),
      ),
    };
  }
  const toAdd: RaceHeatAssignment[] = [];
  for (const comp of [...pkg.races].sort((a, b) => a.sequence - b.sequence)) {
    const pick = picks.get(comp.ref);
    if (!pick) continue;
    const already = heats.some(
      (h) => h.assignedTo === memberId && h.productId === pick.productId && h.heatId === pick.start,
    );
    if (already) continue;
    toAdd.push({
      productId: pick.productId,
      track: (pick.track as RaceHeatAssignment["track"]) ?? null,
      tier: comp.tier,
      category,
      heatId: pick.start,
      bmiLineId: null,
      assignedTo: memberId,
    });
  }
  return { toAdd, toRemove: [] };
}
