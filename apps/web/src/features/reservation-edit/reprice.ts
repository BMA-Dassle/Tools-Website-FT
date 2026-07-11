/**
 * Reservation-edit repricing engine. PURE — no I/O. Callers (plan.ts) load
 * rows/products and inject resolvers; this module only computes lines.
 *
 * Output is LINES, never a charged total: the authoritative money number is
 * always Square `orders/calculate` on these lines (plan.ts), keeping the
 * displayed diff and the charged diff one and the same.
 *
 * Pricing-mode ground truth: booking_metadata.bowling stamp (PR 0). Legacy
 * rows fall back to deriving from the stored lines + the experience the
 * primary product maps to — and REFUSE (pricing_unresolvable) rather than
 * guess when the arithmetic doesn't reconcile.
 */

import {
  comboItemizedLinesForRacers,
  type ComboItemLine,
  type ComboRacerInput,
} from "~/features/combos/combo-pricing";
import type { ComboSpecial } from "~/features/combos/combo-specials";
import { buildKbfExtraSquareLineItems } from "~/features/booking/service/kbf-pricing";
import { LICENSE_PRICE } from "~/features/booking/service/race-pricing";

import {
  EditGuardError,
  type BowlingBookedStamp,
  type EditRacerAdd,
  type EditSpec,
  type EditWarning,
  type HeatMeta,
  type ProductFacts,
  type RepricedLine,
  type StoredLine,
} from "./types";

/* ── Booked-pricing resolution ────────────────────────────────────────── */

export interface ResolvedBookedPricing extends BowlingBookedStamp {
  source: "stamp" | "derived";
}

const PRIMARY_KINDS = new Set(["kbf", "open", "hourly"]);

/** Multipliers the duration options actually sell (sanity bound for legacy). */
const SANE_MULTIPLIERS = new Set([1, 1.5, 2, 2.5, 3]);

const isStamp = (v: unknown): v is BowlingBookedStamp => {
  if (v === null || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    (s.pricingMode === "per_lane" || s.pricingMode === "per_person") &&
    typeof s.laneCount === "number" &&
    s.laneCount >= 1 &&
    typeof s.durationMultiplier === "number" &&
    s.durationMultiplier > 0
  );
};

/**
 * Resolve HOW the reservation was priced. Prefers the PR-0 stamp; legacy rows
 * derive from the primary line's quantity arithmetic and the experience the
 * caller resolved for that product. Throws pricing_unresolvable when neither
 * path reconciles — the edit falls to manual handling, never a guess.
 */
export const resolveBookedPricing = (params: {
  bookingMetadata?: Record<string, unknown> | null;
  playerCount: number;
  lines: StoredLine[];
  /** Experience facts for the primary product (legacy fallback); null = unknown. */
  experienceKind?: "kbf" | "open" | "hourly" | null;
  experienceSlug?: string | null;
}): ResolvedBookedPricing => {
  const stamp = (params.bookingMetadata as { bowling?: unknown } | null | undefined)?.bowling;
  if (isStamp(stamp)) return { ...stamp, source: "stamp" };

  const primaries = params.lines.filter(
    (l) => l.productKind != null && PRIMARY_KINDS.has(l.productKind),
  );
  if (primaries.length !== 1) {
    throw new EditGuardError(
      "pricing_unresolvable",
      `expected exactly one primary lane line, found ${primaries.length}`,
    );
  }
  const primary = primaries[0];
  if (params.experienceKind == null) {
    throw new EditGuardError("pricing_unresolvable", "no experience resolved for primary product");
  }

  const perLane =
    params.experienceKind === "hourly" || (params.experienceSlug ?? "").startsWith("pizza-bowl");
  const playerCount = Math.max(1, params.playerCount);
  // The wizard's default lane rule (BowlingPlayersStep): 6 players per lane.
  const laneCount = perLane ? Math.max(1, Math.ceil(playerCount / 6)) : 1;
  const divisor = perLane ? laneCount : playerCount;
  const multiplier = primary.quantity / divisor;
  if (!SANE_MULTIPLIERS.has(multiplier)) {
    throw new EditGuardError(
      "pricing_unresolvable",
      `derived duration multiplier ${multiplier} is not a known option`,
    );
  }
  return {
    experienceSlug: params.experienceSlug ?? null,
    laneCount: perLane ? laneCount : Math.max(1, Math.ceil(playerCount / 6)),
    durationMultiplier: multiplier,
    pricingMode: perLane ? "per_lane" : "per_person",
    source: "derived",
  };
};

/* ── Bowling / hourly / pizza-bowl reprice ────────────────────────────── */

export interface BowlingRepriceResult {
  lines: RepricedLine[];
  newPlayerCount: number;
  newLaneCount: number;
  /** Differs from booked.durationMultiplier only on a duration change. */
  newDurationMultiplier: number;
  warnings: EditWarning[];
}

/** A resolved bowling_experience_duration_options row (hourly rentals). */
export interface DurationOptionFacts {
  id: number;
  label: string;
  squareMultiplier: number;
  /** When set, the primary line books THIS product instead of the base one. */
  overrideSquareProductId: number | null;
  overridePriceCents: number | null;
  overrideCatalogObjectId: string | null;
  overrideLabel?: string | null;
}

const heldPrice = (l: StoredLine): { unit: number; held: boolean } => {
  // Never silently reprice a discounted booking to the live catalog price —
  // keep the stored unit price and surface the hold to staff.
  if (l.catalogPriceCents != null && l.catalogPriceCents !== l.unitPriceCents) {
    return { unit: l.unitPriceCents, held: true };
  }
  return { unit: l.catalogPriceCents ?? l.unitPriceCents, held: false };
};

/**
 * Recompute the full desired line set for a bowling/KBF-shaped row. The
 * primary line scales by pricing mode; shoe lines follow spec.shoes wholesale;
 * every other line is carried UNCHANGED (food/attraction add-ons have their
 * own edit paths — silently scaling them here would move money nobody asked
 * to move).
 */
export const repriceBowling = (params: {
  booked: ResolvedBookedPricing;
  currentPlayerCount: number;
  lines: StoredLine[];
  spec: Pick<EditSpec, "playerCount" | "laneCount" | "shoes">;
  /** Catalog facts for shoe products that may be ADDED. */
  shoeCatalog: ProductFacts[];
  /** Resolved duration option when spec.durationOptionId is set (hourly). */
  durationOption?: DurationOptionFacts | null;
  /**
   * The DESIRED primary product after a duration change (resolved by the
   * caller from the experience's base item or the option's override). When
   * set, the primary line swaps to this product at its live catalog price.
   */
  desiredPrimary?: ProductFacts | null;
}): BowlingRepriceResult => {
  const { booked, lines, spec, shoeCatalog, durationOption, desiredPrimary } = params;
  const warnings: EditWarning[] = [];

  if (durationOption && booked.pricingMode !== "per_lane") {
    throw new EditGuardError(
      "pricing_unresolvable",
      "duration options only apply to per-lane (hourly) experiences",
    );
  }
  const newMultiplier = durationOption?.squareMultiplier ?? booked.durationMultiplier;

  const currentPlayers = Math.max(1, params.currentPlayerCount);
  const newPlayers = Math.max(1, spec.playerCount ?? currentPlayers);
  const defaultLanes =
    booked.pricingMode === "per_lane" ? booked.laneCount : Math.max(1, Math.ceil(newPlayers / 6));
  const newLanes = Math.max(1, spec.laneCount ?? defaultLanes);

  if (booked.pricingMode === "per_person" && spec.laneCount != null) {
    warnings.push({
      severity: "info",
      code: "lane_count_ignored",
      message: "per-person experiences derive lanes from players; explicit lane count noted only",
    });
  }

  const out: RepricedLine[] = [];
  let sawPrimary = false;

  for (const l of lines) {
    const kind = l.productKind;
    if (kind != null && PRIMARY_KINDS.has(kind)) {
      if (sawPrimary) {
        throw new EditGuardError("pricing_unresolvable", "multiple primary lane lines");
      }
      sawPrimary = true;
      const bookedCount = booked.pricingMode === "per_lane" ? booked.laneCount : currentPlayers;
      const perUnit = l.quantity / (bookedCount * booked.durationMultiplier);
      if (!Number.isInteger(perUnit) || perUnit < 1) {
        throw new EditGuardError(
          "pricing_unresolvable",
          `primary quantity ${l.quantity} does not reconcile with booked pricing`,
        );
      }
      const newCount = booked.pricingMode === "per_lane" ? newLanes : newPlayers;
      const qty = perUnit * newCount * newMultiplier;

      if (desiredPrimary) {
        // Duration change: the primary line SWAPS to the resolved product
        // (base item or the option's override) at its live catalog price —
        // there is no "held" price to preserve for a product the guest is
        // newly choosing.
        const wasHeld = l.catalogPriceCents != null && l.catalogPriceCents !== l.unitPriceCents;
        if (wasHeld) {
          warnings.push({
            severity: "warning",
            code: "price_hold_dropped",
            message: `"${l.label}" had a discounted price — the new duration books at the live catalog price`,
          });
        }
        out.push({
          squareProductId: desiredPrimary.squareProductId,
          squareCatalogObjectId: desiredPrimary.squareCatalogObjectId,
          label: desiredPrimary.label,
          quantity: qty,
          unitPriceCents: desiredPrimary.priceCents,
          role: "primary",
        });
        continue;
      }

      const { unit, held } = heldPrice(l);
      if (held) {
        warnings.push({
          severity: "warning",
          code: "price_held",
          message: `"${l.label}" keeps its booked unit price (differs from live catalog)`,
        });
      }
      out.push({
        squareProductId: l.squareProductId,
        squareCatalogObjectId: l.squareCatalogObjectId,
        label: l.label,
        quantity: qty,
        unitPriceCents: unit,
        role: "primary",
        ...(held ? { priceHeld: true } : {}),
      });
      continue;
    }

    if (kind === "addon_shoe") {
      // Handled wholesale from spec.shoes below (or carried when spec omits it).
      continue;
    }

    // Anything else (food packages, attraction add-ons, unknown products):
    // carry unchanged — these move through their own edit flows.
    out.push({
      squareProductId: l.squareProductId,
      squareCatalogObjectId: l.squareCatalogObjectId,
      label: l.label,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      role: l.unitPriceCents === 0 ? "passthrough" : "secondary",
    });
  }

  if (!sawPrimary) {
    throw new EditGuardError("pricing_unresolvable", "no primary lane line on the reservation");
  }

  // ── Shoes: desired quantities win wholesale ─────────────────────────
  const storedShoes = lines.filter((l) => l.productKind === "addon_shoe");
  if (spec.shoes == null) {
    for (const l of storedShoes) {
      const { unit, held } = heldPrice(l);
      out.push({
        squareProductId: l.squareProductId,
        squareCatalogObjectId: l.squareCatalogObjectId,
        label: l.label,
        quantity: l.quantity,
        unitPriceCents: unit,
        role: "shoe",
        ...(held ? { priceHeld: true } : {}),
      });
    }
  } else {
    const byProductId = new Map(
      storedShoes.filter((l) => l.squareProductId != null).map((l) => [l.squareProductId!, l]),
    );
    const catalogById = new Map(shoeCatalog.map((p) => [p.squareProductId, p]));
    for (const [idStr, qty] of Object.entries(spec.shoes)) {
      const id = Number(idStr);
      if (!Number.isInteger(qty) || qty < 0) {
        throw new EditGuardError("pricing_unresolvable", `invalid shoe quantity for product ${id}`);
      }
      if (qty === 0) continue;
      const stored = byProductId.get(id);
      if (stored) {
        const { unit, held } = heldPrice(stored);
        out.push({
          squareProductId: id,
          squareCatalogObjectId: stored.squareCatalogObjectId,
          label: stored.label,
          quantity: qty,
          unitPriceCents: unit,
          role: "shoe",
          ...(held ? { priceHeld: true } : {}),
        });
        continue;
      }
      const product = catalogById.get(id);
      if (!product || product.productKind !== "addon_shoe") {
        throw new EditGuardError("pricing_unresolvable", `unknown shoe product ${id}`);
      }
      out.push({
        squareProductId: id,
        squareCatalogObjectId: product.squareCatalogObjectId,
        label: product.label,
        quantity: qty,
        unitPriceCents: product.priceCents,
        role: "shoe",
      });
    }
    // Dropped shoe lines simply don't reappear (qty 0 or omitted id).
  }

  return {
    lines: out,
    newPlayerCount: newPlayers,
    newLaneCount: newLanes,
    newDurationMultiplier: newMultiplier,
    warnings,
  };
};

/* ── KBF extras reprice ───────────────────────────────────────────────── */

/**
 * KBF money lines come from ONE builder shared with booking/quote
 * (buildKbfExtraSquareLineItems) so an edited KBF party can never drift from
 * what booking would charge for the same roster. The $0 base line scales to
 * total players; shoes follow the bowling rules.
 */
export const repriceKbfExtras = (params: {
  isVip: boolean;
  isFriday: boolean;
  counts: { kbfKidCount: number; fbfAdultCount: number; paidAdultCount: number };
}): RepricedLine[] =>
  buildKbfExtraSquareLineItems({
    isVip: params.isVip,
    isFriday: params.isFriday,
    kbfKidCount: params.counts.kbfKidCount,
    fbfAdultCount: params.counts.fbfAdultCount,
    paidAdultCount: params.counts.paidAdultCount,
  }).map((l) => ({
    squareProductId: null,
    squareCatalogObjectId: l.catalogObjectId,
    label: l.name,
    quantity: Number(l.quantity),
    unitPriceCents: l.basePriceMoney.amount,
    role: "kbf_extra" as const,
  }));

/* ── Race delta reprice ───────────────────────────────────────────────── */

export interface RaceHeatSlot {
  heatId: string;
  track: string | null;
  tier: string | null;
  productId: string | null;
}

export interface RaceRepriceDelta {
  /** Lines the edit ADDS to the day-of order (per added racer, per heat). */
  addedLines: RepricedLine[];
  /** Metadata heats the edit REMOVES, with their line value + BMI line ref. */
  removedHeats: Array<{
    index: number;
    heat: HeatMeta;
    bmiLineId: string | null;
    label: string;
    unitPriceCents: number;
  }>;
  /** License lines added for new racers. */
  warnings: EditWarning[];
}

/**
 * Delta repricer for race rows: each added racer joins every DISTINCT heat
 * slot already on the reservation (same product/track/tier as the roster);
 * removals are by metadata index. Product prices are injected so this module
 * stays pure — plan.ts wires getRaceProductById + the visit-date schedule.
 */
export const repriceRaceDelta = (params: {
  heatsMeta: HeatMeta[];
  add: EditRacerAdd[];
  removeHeatIndexes: number[];
  /** Resolve a race product's unit price in cents (null = unknown product). */
  productPriceCents: (productId: string, category: "adult" | "junior") => number | null;
  /** Resolve the product's display label. */
  productLabel: (productId: string, category: "adult" | "junior") => string;
}): RaceRepriceDelta => {
  const { heatsMeta, add, removeHeatIndexes } = params;
  const warnings: EditWarning[] = [];

  // Removals — validate indexes against the pinned metadata snapshot.
  const removedHeats: RaceRepriceDelta["removedHeats"] = [];
  const removeSet = new Set(removeHeatIndexes);
  for (const index of removeSet) {
    const heat = heatsMeta[index];
    if (!heat) {
      throw new EditGuardError("plan_stale", `heat index ${index} not on the reservation`);
    }
    const category = heat.category === "junior" ? "junior" : "adult";
    const price = heat.productId ? params.productPriceCents(heat.productId, category) : null;
    if (price == null) {
      warnings.push({
        severity: "warning",
        code: "heat_price_unknown",
        message: `heat ${heat.heatId ?? index} has no resolvable product price; verify the diff`,
      });
    }
    removedHeats.push({
      index,
      heat,
      bmiLineId: heat.bmiLineId ?? null,
      label: heat.productId ? params.productLabel(heat.productId, category) : "Race heat",
      unitPriceCents: price ?? 0,
    });
  }

  // Additions — every added racer joins the surviving distinct heat slots.
  const surviving = heatsMeta.filter((_, i) => !removeSet.has(i));
  const slotByHeatId = new Map<string, RaceHeatSlot>();
  for (const h of surviving) {
    if (h.heatId && !slotByHeatId.has(h.heatId)) {
      slotByHeatId.set(h.heatId, {
        heatId: h.heatId,
        track: h.track ?? null,
        tier: h.tier ?? null,
        productId: h.productId ?? null,
      });
    }
  }
  if (add.length > 0 && slotByHeatId.size === 0) {
    throw new EditGuardError(
      "pricing_unresolvable",
      "cannot add racers: no surviving heats to join",
    );
  }

  const addedLines: RepricedLine[] = [];
  for (const racer of add) {
    const category = racer.category ?? "adult";
    for (const slot of slotByHeatId.values()) {
      if (!slot.productId) {
        throw new EditGuardError(
          "pricing_unresolvable",
          `heat ${slot.heatId} has no product id to price the added racer`,
        );
      }
      const price = params.productPriceCents(slot.productId, category);
      if (price == null) {
        throw new EditGuardError(
          "pricing_unresolvable",
          `no price for product ${slot.productId} (${category})`,
        );
      }
      addedLines.push({
        squareProductId: null,
        squareCatalogObjectId: null,
        label: params.productLabel(slot.productId, category),
        quantity: 1,
        unitPriceCents: price,
        role: "race",
      });
    }
    if (racer.isNew) {
      addedLines.push({
        squareProductId: null,
        squareCatalogObjectId: null,
        label: "FastTrax License",
        quantity: 1,
        unitPriceCents: Math.round(LICENSE_PRICE * 100),
        role: "license",
      });
    }
  }

  return { addedLines, removedHeats, warnings };
};

/* ── Combo reprice (full roster) ──────────────────────────────────────── */

export interface ComboRepriceResult {
  /** Per-entity desired line sets, from the shared booking seam. */
  byEntity: Array<{ entity: string; lines: RepricedLine[] }>;
  warnings: EditWarning[];
}

/**
 * Reprice a combo money group for a NEW roster via the exact seam booking
 * uses (comboItemizedLinesForRacers) — an edited combo can never drift from
 * what booking would have charged for the same roster.
 */
export const repriceComboRacers = (params: {
  combo: ComboSpecial;
  date: string;
  racers: ComboRacerInput[];
}): ComboRepriceResult => {
  const itemized = comboItemizedLinesForRacers({
    combo: params.combo,
    date: params.date,
    racers: params.racers,
  });
  if (!itemized) {
    throw new EditGuardError(
      "pricing_unresolvable",
      "combo has no revenue split (or empty roster) — cannot itemize",
    );
  }
  const byEntity = new Map<string, RepricedLine[]>();
  for (const l of itemized as ComboItemLine[]) {
    const arr = byEntity.get(l.entity) ?? [];
    arr.push({
      squareProductId: null,
      squareCatalogObjectId: l.catalogObjectId,
      label: l.name,
      quantity: l.quantity,
      unitPriceCents: l.unitCents,
      role: "secondary",
    });
    byEntity.set(l.entity, arr);
  }
  return {
    byEntity: [...byEntity.entries()].map(([entity, lines]) => ({ entity, lines })),
    warnings: [],
  };
};
