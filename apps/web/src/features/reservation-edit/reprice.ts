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
  /**
   * Carry the primary line UNCHANGED (shoe/roster/attraction-only edits).
   * Lets legacy rows whose pricing mode can't be resolved still take edits
   * that never scale the lane line.
   */
  carryPrimary?: boolean;
  /**
   * Whether this edit needs the lane line's shape to be well-formed — true
   * only when something scales it (players / lanes / duration). Default true.
   *
   * The primary-line guards below exist to protect that ARITHMETIC. When
   * nothing scales the lane, its shape is irrelevant and policing it blocks
   * edits that are perfectly safe — a refund of a shoe rental or a booking fee
   * must not care whether the booking has one lane line, two, or none. Real
   * rows that hit this: KBF (bowling is free, so there is NO paid lane line at
   * all) and any row whose lane line has a NULL square_product_id, so its kind
   * cannot be resolved from the catalog.
   */
  primaryRequired?: boolean;
}): BowlingRepriceResult => {
  const { booked, lines, spec, shoeCatalog, durationOption, desiredPrimary } = params;
  const warnings: EditWarning[] = [];
  const primaryRequired = params.primaryRequired !== false;
  /** Pass the lane line through untouched — explicitly, or because no part of
   *  this edit scales it. */
  const carryPrimary = params.carryPrimary || !primaryRequired;

  // Which lines claim to BE the lane. A $0 line only counts when nothing PAID
  // claims that role: VIP packages ship a comped extra ("VIP Chips & Salsa")
  // catalogued as a bowling product, and it must not shadow the real lane and
  // trip "multiple primary lane lines". A genuinely comped booking still
  // resolves, because then the $0 line is the only candidate.
  const primaryCandidates = lines.filter(
    (l) => l.productKind != null && PRIMARY_KINDS.has(l.productKind),
  );
  const paidPrimaries = primaryCandidates.filter((l) => l.unitPriceCents > 0);
  const primarySet = new Set(paidPrimaries.length > 0 ? paidPrimaries : primaryCandidates);

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
    if (primarySet.has(l)) {
      if (sawPrimary && primaryRequired) {
        throw new EditGuardError("pricing_unresolvable", "multiple primary lane lines");
      }
      sawPrimary = true;
      if (carryPrimary) {
        // Nothing in this edit scales the lane line — pass it through as
        // booked (price and quantity untouched, no arithmetic to reconcile).
        out.push({
          squareProductId: l.squareProductId,
          squareCatalogObjectId: l.squareCatalogObjectId,
          label: l.label,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          role: "primary",
        });
        continue;
      }
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

  if (!sawPrimary && !carryPrimary) {
    throw new EditGuardError("pricing_unresolvable", "no primary lane line on the reservation");
  }
  if (!sawPrimary) {
    // Reached on rows that legitimately have no priced lane line — KBF (the
    // bowling is free, only shoes/fees were sold) or a lane line whose
    // square_product_id is NULL. Nothing here scales it, so the edit proceeds
    // on the add-on and order lines; say so rather than leaving it implicit.
    warnings.push({
      severity: "info",
      code: "no_primary_line",
      message:
        "This booking has no priced lane line (free bowling, or a line booked without a " +
        "catalog id) — only add-ons, fees, and other day-of charges can change.",
    });
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

/** A booked/added heat product resolved for a SPECIFIC racer category. */
export interface ResolvedRaceProduct {
  /** The BMI product to book for that category (cross-category counterpart). */
  bmiProductId: string;
  label: string;
  priceCents: number;
  /** Square catalog id — the day-of order lines link to THIS, not our names. */
  catalogObjectId: string | null;
}

export interface RaceAddPlan {
  firstName: string;
  lastName: string;
  isNew: boolean;
  bmiPersonId: string | null;
  category: "adult" | "junior";
  heats: Array<{ heatId: string; track: string | null; tier: string | null; bmiProductId: string }>;
}

export interface RaceRepriceDelta {
  /** Lines the edit ADDS to the day-of order (per added racer, per heat). */
  addedLines: RepricedLine[];
  /** Metadata heats the edit REMOVES, with their line refs for matching. */
  removedHeats: Array<{
    index: number;
    heat: HeatMeta;
    bmiLineId: string | null;
    label: string;
    unitPriceCents: number;
    catalogObjectId: string | null;
  }>;
  /** Per-racer resolved booking plan (bmi-sync executes exactly this). */
  raceAdds: RaceAddPlan[];
  warnings: EditWarning[];
}

/**
 * Delta repricer for race rows: each added racer joins every DISTINCT heat
 * slot already on the reservation; removals are by metadata index. Product
 * resolution is injected (plan.ts wires the registry + Square catalog map)
 * and is CATEGORY-AWARE — adding an adult to junior heats resolves the adult
 * counterpart product (same tier/track/schedule) for pricing AND booking.
 */
export const repriceRaceDelta = (params: {
  heatsMeta: HeatMeta[];
  add: EditRacerAdd[];
  removeHeatIndexes: number[];
  /**
   * Resolve the product for a heat slot at the requested category. Returns
   * null when unknown; a string return is a human-readable refusal reason
   * (e.g. "juniors can't race the Red track").
   */
  resolveProduct: (
    productId: string,
    category: "adult" | "junior",
  ) => ResolvedRaceProduct | string | null;
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
    const resolved = heat.productId ? params.resolveProduct(heat.productId, category) : null;
    const product = typeof resolved === "object" && resolved !== null ? resolved : null;
    if (!product) {
      warnings.push({
        severity: "warning",
        code: "heat_price_unknown",
        message: `heat ${heat.heatId ?? index} has no resolvable product; verify the diff`,
      });
    }
    removedHeats.push({
      index,
      heat,
      bmiLineId: heat.bmiLineId ?? null,
      label: product?.label ?? "Race heat",
      unitPriceCents: product?.priceCents ?? 0,
      catalogObjectId: product?.catalogObjectId ?? null,
    });
  }

  // Removing EVERY heat with nothing added is a cancellation, not an edit —
  // the cancel cascade owns refunds/teardown for that. Name BOTH doors: Cancel
  // is hidden once the venue charge lands, so on a settled visit the money
  // comes back through the day-of line control instead.
  if (removeSet.size > 0 && removeSet.size >= heatsMeta.length && add.length === 0) {
    throw new EditGuardError(
      "unsupported_kind",
      "removing every heat empties the reservation — use Cancel if the race has not happened, " +
        "or refund it from “Charges on the day-of order” if it has",
    );
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
  const raceAdds: RaceAddPlan[] = [];
  for (const racer of add) {
    const category = racer.category ?? "adult";
    const plan: RaceAddPlan = {
      firstName: racer.firstName,
      lastName: racer.lastName ?? "",
      isNew: racer.isNew ?? false,
      bmiPersonId: racer.bmiPersonId ?? null,
      category,
      heats: [],
    };
    for (const slot of slotByHeatId.values()) {
      if (!slot.productId) {
        throw new EditGuardError(
          "pricing_unresolvable",
          `heat ${slot.heatId} has no product id to price the added racer`,
        );
      }
      const resolved = params.resolveProduct(slot.productId, category);
      if (typeof resolved === "string") {
        throw new EditGuardError("pricing_unresolvable", resolved);
      }
      if (!resolved) {
        throw new EditGuardError(
          "pricing_unresolvable",
          `no ${category} product matches heat ${slot.heatId} — add this racer via the booking flow`,
        );
      }
      addedLines.push({
        squareProductId: null,
        squareCatalogObjectId: resolved.catalogObjectId,
        label: resolved.label,
        quantity: 1,
        unitPriceCents: resolved.priceCents,
        role: "race",
      });
      plan.heats.push({
        heatId: slot.heatId,
        track: slot.track,
        tier: slot.tier,
        bmiProductId: resolved.bmiProductId,
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
    raceAdds.push(plan);
  }

  return { addedLines, removedHeats, raceAdds, warnings };
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
