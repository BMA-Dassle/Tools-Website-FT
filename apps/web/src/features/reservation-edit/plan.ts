/**
 * buildEditPlan — the reservation-edit dry-run.
 *
 * Loads the Neon money group + LIVE Square facts, reprices the desired end
 * state (reprice.ts), computes the authoritative diff via Square
 * POST /v2/orders/calculate on the would-be order bodies, and emits the
 * ordered step list execution will follow. The plan's hash seals
 * displayed == executed: execution rebuilds the plan fresh and refuses on
 * hash mismatch (plan_stale).
 *
 * READ-ONLY: this module never mutates Square, QAMF, BMI, or Neon.
 */

import {
  getBowlingReservation,
  getBowlingSquareProducts,
  getReservationPlayersWithShoeAllowance,
  listCancelGroupReservations,
  type BowlingReservation,
  type BowlingSquareProduct,
} from "@/lib/bowling-db";
import { hasOpenEditEvent } from "@/lib/reservation-edit-log";
import {
  fetchGiftCardFacts,
  fetchOrderFacts,
  fetchPaymentFacts,
  sq,
} from "~/features/cancellation/square-actions";
import { resolveCenter } from "~/features/cancellation/centers";
import { getComboSpecial, type ComboSpecial } from "~/features/combos/combo-specials";
import { getRaceProductById, _allRaceProducts } from "~/features/booking/service/race-products";
import { lookupCatalogId } from "~/features/booking/data/square-catalog-map";
import { isFridayYmd } from "~/features/booking/service/kbf-pricing";
import { getChargeableCard } from "~/features/card-vault";

import { loadExperiencesForCenter, matchExperienceForRow } from "./experience-resolve";
import { assertEditable, selectPhase, type SquareOrderState } from "./guards";
import { planHash as hashPlan } from "./hash";
import {
  repriceBowling,
  repriceComboRacers,
  repriceKbfExtras,
  repriceRaceDelta,
  resolveBookedPricing,
  type DurationOptionFacts,
  type RaceAddPlan,
  type ResolvedBookedPricing,
  type ResolvedRaceProduct,
} from "./reprice";
import {
  EditGuardError,
  type BowlingBookedStamp,
  type EditPaymentSource,
  type EditPhase,
  type EditSettlement,
  type EditSpec,
  type EditStep,
  type EditWarning,
  type HeatMeta,
  type ProductFacts,
  type RepricedLine,
  type StoredLine,
} from "./types";

/* ── Plan shapes ──────────────────────────────────────────────────────── */

/** One line as it appears on (or will be PUT to) a Square day-of order. */
export interface PlanLine {
  /** Live order line uid — kept on carried/updated lines, null on new ones. */
  uid: string | null;
  catalogObjectId: string | null;
  name: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  note: string | null;
}

export interface EditPlanLeg {
  reservationId: number;
  productKind: BowlingReservation["productKind"];
  dayofOrderId: string | null;
  orderState: SquareOrderState | null;
  orderVersion: number | null;
  orderLocationId: string | null;
  phase: EditPhase;
  oldLines: PlanLine[];
  newLines: PlanLine[];
  oldTotalCents: number;
  newTotalCents: number;
  /** Desired Neon reservation lines after the edit (bowling/KBF legs). */
  newNeonLines: RepricedLine[] | null;
  newPlayerCount: number | null;
  newLaneCount: number | null;
  /** Set on a duration change: the target option (QAMF rebook uses its Time id). */
  newDuration: { optionId: number; qamfOptionId: number; multiplier: number } | null;
  /**
   * The BOOKED pricing stamp this plan resolved (stamped or derived) — null on
   * race legs and carry-mode bowling legs. commitNeon persists it (with the
   * newLaneCount/newDuration overrides applied), so legacy rows self-heal
   * their booking_metadata.bowling on the first successful edit.
   */
  resolvedStamp: BowlingBookedStamp | null;
  /** Race legs: metadata heats removed / racers added (execution inputs). */
  removedHeats: Array<{ index: number; bmiLineId: string | null; label: string }> | null;
  /**
   * Race legs: per-racer resolved booking plan for adds — bmi-sync books
   * EXACTLY these products (cross-category counterparts already resolved).
   */
  raceAdds: RaceAddPlan[] | null;
  /** Attraction add-on qty changes (execution inputs for the BMI replace). */
  attractionChanges: Array<{
    index: number;
    slug: string;
    name: string;
    newQuantity: number;
    oldQuantity: number;
    unitPriceCents: number;
    bmiOrderId: string | null;
    bmiBillLineId: string | null;
  }> | null;
}

/** Current editable values — initializes the modal form on an empty dry-run. */
export interface EditCurrentState {
  playerCount: number;
  laneCount: number | null;
  pricingMode: "per_lane" | "per_person" | null;
  shoes: Array<{
    squareProductId: number;
    label: string;
    quantity: number;
    unitPriceCents: number;
  }>;
  shoeCatalog: Array<{ squareProductId: number; label: string; priceCents: number }>;
  players: Array<{
    slot: number;
    name: string | null;
    shoeSize: string | null;
    bumpers: boolean | null;
  }>;
  heats: Array<{
    index: number;
    heatId: string | null;
    racer: string | null;
    label: string;
    category: "adult" | "junior";
    removable: boolean;
  }>;
  /** Hourly rentals: selectable lane-time lengths (empty for non-hourly). */
  durationOptions: Array<{ id: number; label: string; multiplier: number }>;
  /** The booked multiplier — identifies the current duration option. */
  durationMultiplier: number | null;
  /** Attraction add-ons on the row (index-addressed for spec.attractions). */
  attractions: Array<{
    index: number;
    name: string;
    quantity: number;
    unitPriceCents: number;
    timeLabel: string;
    /** BMI line ids present → editable; missing → display-only. */
    editable: boolean;
  }>;
  /**
   * LIVE day-of order lines, uid-addressed for spec.orderLines. `editable`
   * marks the ones the booking engine does NOT own (food, POS add-ons) —
   * those are the only ones staff may change here; everything else has to move
   * through its typed field so the booking follows the money.
   */
  orderLines: Array<{
    uid: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
    editable: boolean;
  }>;
}

/**
 * Largest gap lane-open will auto-comp onto the internal gift card when a
 * pre-tax deposit falls short of the tax-inclusive day-of total. Mirrors
 * GAP_GUARD_CENTS in lib/bowling-lane-open.ts — a refund may exceed the
 * deposit's refundable capacity by at most this much before it stops being
 * explainable as that comp coming back.
 */
const GAP_COMP_MAX_CENTS = 200;

export interface EditPlan {
  anchorId: number;
  legIds: number[];
  isCombo: boolean;
  phase: EditPhase;
  spec: EditSpec;
  legs: EditPlanLeg[];
  /** Σ new − Σ old across the money group (tax-inclusive, cents). */
  diffCents: number;
  /**
   * Cents the GUEST actually gets back — capped at the deposit tenders'
   * un-refunded capacity. Equals |diffCents| except on gap-comped rows, where
   * the house's lane-open courtesy has no card to return to.
   */
  guestOwedCents: number;
  /**
   * Cents to strip off the internal gift card — everything the day-of refund
   * credits back to it, guest share AND comp share. Never less than
   * guestOwedCents; a shortfall would leave spendable value behind.
   */
  gcDecrementCents: number;
  settlement: "charge" | EditSettlement | "none";
  /** Card that will be charged for an increase (null = none on file). */
  chargeCard: { cardId: string; brand: string; last4: string } | null;
  giftCard: { id: string; gan: string; balanceCents: number; state: string } | null;
  steps: EditStep[];
  warnings: EditWarning[];
  current: EditCurrentState;
  planHash: string;
}

export interface BuildEditPlanRequest {
  neonId: number;
  spec: EditSpec;
  settlement?: EditSettlement;
  paymentSource?: EditPaymentSource;
  managerOverride?: boolean;
}

/* ── Square order snapshot + calculate ────────────────────────────────── */

interface OrderSnapshot {
  id: string;
  state: SquareOrderState;
  version: number;
  locationId: string;
  tenderCount: number;
  totalCents: number;
  lines: PlanLine[];
  /** Catalog tax refs to replay on orders/calculate (uid + catalog + scope). */
  taxes: Array<{ uid?: string; catalog_object_id: string; scope: string }>;
  /** Catalog discount refs to replay on orders/calculate. */
  discounts: Array<{ uid?: string; catalog_object_id: string; scope: string }>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const fetchOrderSnapshot = async (orderId: string): Promise<OrderSnapshot> => {
  const r = await sq("GET", `/orders/${orderId}`);
  if (!r.ok || !r.json?.order) {
    throw new Error(`order ${orderId} fetch failed (${r.status})`);
  }
  const o = r.json.order;
  const lines: PlanLine[] = (o.line_items ?? []).map((li: any) => ({
    uid: li.uid ?? null,
    catalogObjectId: li.catalog_object_id ?? null,
    name: li.name ?? "",
    quantity: Number(li.quantity ?? "0"),
    unitPriceCents: li.base_price_money?.amount ?? 0,
    totalCents: li.total_money?.amount ?? 0,
    note: li.note ?? null,
  }));
  const catalogRefs = (arr: any[] | undefined) =>
    (arr ?? [])
      .filter((t: any) => t.catalog_object_id)
      .map((t: any) => ({
        ...(t.uid ? { uid: t.uid } : {}),
        catalog_object_id: t.catalog_object_id,
        scope: t.scope ?? "ORDER",
      }));
  return {
    id: o.id,
    state: (o.state ?? "OPEN") as SquareOrderState,
    version: o.version ?? 0,
    locationId: o.location_id ?? "",
    tenderCount: (o.tenders ?? []).length,
    totalCents: o.total_money?.amount ?? 0,
    lines,
    taxes: catalogRefs(o.taxes),
    discounts: catalogRefs(o.discounts),
  };
};

/**
 * Authoritative repricing: let Square compute the tax-inclusive total of the
 * desired line set, replaying the source order's catalog taxes/discounts.
 * This number is what the modal displays AND what execution charges/refunds —
 * client math never enters the diff.
 */
const calculateOrderTotal = async (
  locationId: string,
  lines: PlanLine[],
  taxes: OrderSnapshot["taxes"],
  discounts: OrderSnapshot["discounts"],
): Promise<number> => {
  if (lines.length === 0) return 0;
  const body = {
    order: {
      location_id: locationId,
      line_items: lines.map((l) => ({
        ...(l.catalogObjectId ? { catalog_object_id: l.catalogObjectId } : { name: l.name }),
        quantity: String(l.quantity),
        base_price_money: { amount: l.unitPriceCents, currency: "USD" },
        ...(l.note ? { note: l.note } : {}),
      })),
      ...(taxes.length > 0 ? { taxes: taxes.map(({ uid: _uid, ...t }) => t) } : {}),
      ...(discounts.length > 0 ? { discounts: discounts.map(({ uid: _uid, ...d }) => d) } : {}),
    },
  };
  const r = await sq("POST", "/orders/calculate", body);
  if (!r.ok || !r.json?.order) {
    throw new Error(
      `orders/calculate failed (${r.status}): ${JSON.stringify(r.json?.errors ?? "").slice(0, 200)}`,
    );
  }
  return r.json.order.total_money?.amount ?? 0;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ── Desired-line assembly ────────────────────────────────────────────── */

const toPlanLine = (l: RepricedLine, uid: string | null): PlanLine => ({
  uid,
  catalogObjectId: l.squareCatalogObjectId,
  name: l.label,
  quantity: l.quantity,
  unitPriceCents: l.unitPriceCents,
  totalCents: l.unitPriceCents * l.quantity,
  note: null,
});

/**
 * Merge repriced Neon lines with the live order: repriced lines claim the uid
 * of the order line they replace (matched by catalog id, then name); order
 * lines with no Neon representation (booking fee, $0 pizza/soda pass-throughs,
 * ad-hoc staff lines) are CARRIED unchanged — an edit only moves the money it
 * was asked to move.
 */
const mergeDesiredWithOrder = (
  repriced: RepricedLine[],
  order: OrderSnapshot | null,
  neonRepresented: (line: PlanLine) => boolean,
): PlanLine[] => {
  if (!order) return repriced.map((l) => toPlanLine(l, null));
  const unclaimed = [...order.lines];
  const claim = (l: RepricedLine): string | null => {
    let idx = l.squareCatalogObjectId
      ? unclaimed.findIndex((o) => o.catalogObjectId === l.squareCatalogObjectId)
      : -1;
    if (idx < 0) idx = unclaimed.findIndex((o) => o.name === l.label);
    if (idx < 0) return null;
    const [hit] = unclaimed.splice(idx, 1);
    return hit.uid;
  };
  const out = repriced.map((l) => {
    const uid = claim(l);
    const pl = toPlanLine(l, uid);
    if (uid) {
      const src = order.lines.find((o) => o.uid === uid);
      if (src?.note) pl.note = src.note;
    }
    return pl;
  });
  for (const rest of unclaimed) {
    // Only carry lines the Neon reprice does NOT own — a repriced-away Neon
    // line (dropped shoes) must not sneak back in via carryover.
    if (!neonRepresented(rest)) out.push({ ...rest });
  }
  return out;
};

/* ── Roster/heat helpers ──────────────────────────────────────────────── */

const heatsFromMetadata = (row: BowlingReservation): HeatMeta[] => {
  const meta = row.bookingMetadata as { heats?: unknown } | undefined;
  if (!meta || !Array.isArray(meta.heats)) return [];
  return meta.heats as HeatMeta[];
};

/**
 * Resolve the product a heat books at the REQUESTED racer category. Same
 * category → the heat's own product. Cross-category (adult joining junior
 * heats or vice versa) → the counterpart product with the same schedule /
 * tier / track. Carries the Square catalog id — day-of order lines are
 * catalog-linked and Square substitutes ITS item names, so catalog id is the
 * only reliable order-line match key.
 */
const resolveRaceProductForCategory = (
  productId: string,
  category: "adult" | "junior",
): ResolvedRaceProduct | string | null => {
  const p = getRaceProductById(productId);
  if (!p) return null;
  const toResolved = (prod: NonNullable<ReturnType<typeof getRaceProductById>>) => ({
    bmiProductId: prod.productId,
    label: prod.name,
    priceCents: Math.round(prod.price * 100),
    catalogObjectId: lookupCatalogId(prod.productId),
  });
  if (p.category === category) return toResolved(p);

  const singles = _allRaceProducts().filter((c) => !c.packType && !c.trackProducts);
  const match = (requireRacerType: boolean, requireTrack: boolean) =>
    singles.find(
      (c) =>
        c.category === category &&
        c.tier === p.tier &&
        c.schedule === p.schedule &&
        (!requireRacerType || c.racerType === p.racerType) &&
        (!requireTrack || p.track == null || c.track === p.track),
    );
  const counterpart = match(true, true) ?? match(false, true);
  if (counterpart) return toResolved(counterpart);
  if (category === "junior" && p.track && p.track !== "Blue" && p.track !== "Mega") {
    return `juniors can't race the ${p.track} track — add them via a Blue/Mega heat booking`;
  }
  return null;
};

const raceProductLabel = (productId: string, category: "adult" | "junior"): string => {
  const resolved = resolveRaceProductForCategory(productId, category);
  return typeof resolved === "object" && resolved !== null
    ? resolved.label
    : `Race product ${productId} (${category})`;
};

/* ── The plan builder ─────────────────────────────────────────────────── */

export const buildEditPlan = async (req: BuildEditPlanRequest): Promise<EditPlan> => {
  const spec = req.spec ?? {};
  const warnings: EditWarning[] = [];

  // 1. Load the anchor + its money group.
  const anchor = await getBowlingReservation(req.neonId);
  if (!anchor) throw new EditGuardError("not_found");
  const group = await listCancelGroupReservations(anchor);
  const legIds = group.map((g) => g.id);
  const isCombo = group.some((g) => g.comboSpecialId != null) && group.length > 1;

  // Mutual exclusion with cancel/edit already in flight (advisory here; the
  // executor re-checks under its Redis lock).
  if (await hasOpenEditEvent(legIds)) {
    warnings.push({
      severity: "warning",
      code: "edit_in_progress",
      message: "another edit attempt is open for this reservation (resume or wait)",
    });
  }

  // 2. LIVE Square facts per leg + phase.
  const centers = resolveCenter(anchor.centerCode, anchor.productKind);
  void centers; // (center identity is used by the executor; loaded here to fail early)

  const legSnapshots = new Map<number, OrderSnapshot | null>();
  for (const leg of group) {
    if (leg.squareDayofOrderId) {
      legSnapshots.set(leg.id, await fetchOrderSnapshot(leg.squareDayofOrderId));
    } else {
      legSnapshots.set(leg.id, null);
    }
  }

  const legPhase = (leg: BowlingReservation): EditPhase => {
    const snap = legSnapshots.get(leg.id) ?? null;
    return selectPhase({
      status: leg.status,
      dayofOrderSentAt: leg.dayofOrderSentAt ?? null,
      hasDayofOrder: !!leg.squareDayofOrderId,
      orderState: snap?.state ?? null,
      orderTenderCount: snap?.tenderCount ?? 0,
    });
  };
  const phases = group.map(legPhase);
  const phase = phases[0];

  const changesLaneCount =
    spec.laneCount != null ||
    // per-person players growth can force a lane-count change (ceil rule) —
    // detected precisely after reprice; pre-check uses the spec signal only.
    false;
  const changesRaceHeats =
    (spec.racers?.add?.length ?? 0) > 0 || (spec.racers?.removeHeatIndexes?.length ?? 0) > 0;

  assertEditable({
    productKind: anchor.productKind,
    phase,
    changesLaneCount,
    changesRaceHeats,
    legPhases: phases,
    isCombo,
    managerOverride: req.managerOverride ?? false,
  });

  // 3. Current-state block (modal form init) — players/shoes/heats/pricing.
  const { players } = await getReservationPlayersWithShoeAllowance(anchor.id);
  // center_code is a mixed namespace (v1 rows: Square location ids, v2 rows:
  // slugs) — fetch the catalog under BOTH so legacy rows still resolve.
  // INACTIVE products are included so rows booked under a since-deactivated
  // product (World Cup VIP switchover) still resolve their kind; only the
  // shoe catalog offered for NEW lines filters to active.
  let centerProducts = await getBowlingSquareProducts(anchor.centerCode, undefined, true);
  const centerSlugForCatalog = resolveCenter(anchor.centerCode, anchor.productKind).slug;
  if (centerProducts.length === 0 && centerSlugForCatalog !== anchor.centerCode) {
    centerProducts = await getBowlingSquareProducts(centerSlugForCatalog, undefined, true);
  }
  const productsById = new Map(centerProducts.map((p) => [p.id, p]));
  const shoeCatalog: ProductFacts[] = centerProducts
    .filter((p) => p.isActive && p.productKind === "addon_shoe")
    .map((p) => ({
      squareProductId: p.id,
      label: p.label,
      priceCents: p.priceCents,
      squareCatalogObjectId: p.squareCatalogObjectId,
      productKind: "addon_shoe" as const,
    }));

  const anchorStoredLines: StoredLine[] = (anchor.lines ?? []).map((l) => {
    const product = l.squareProductId != null ? productsById.get(l.squareProductId) : undefined;
    return {
      squareProductId: l.squareProductId ?? null,
      label: l.label,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      productKind: product?.productKind ?? null,
      catalogPriceCents: product?.priceCents ?? null,
      squareCatalogObjectId: product?.squareCatalogObjectId ?? null,
    };
  });

  const heatsMeta = heatsFromMetadata(anchor);
  // Lines the booking model owns on the ANCHOR's order: everything stored as
  // a reservation line (experience, shoes, fees), every attraction add-on, and
  // every race product. Anything else on the order came from outside the
  // engine (food route, POS) and is the only thing spec.orderLines may touch.
  const anchorEngineLines: EngineOwnedLine[] = [
    ...anchorStoredLines.map((l) => ({
      squareCatalogObjectId: l.squareCatalogObjectId,
      label: l.label,
    })),
    ...(anchor.attractionBookings ?? []).map((a) => ({
      squareCatalogObjectId: a.squareCatalogObjectId ?? null,
      label: a.name,
    })),
    ..._allRaceProducts().map((p) => ({ squareCatalogObjectId: null, label: p.name })),
  ];

  const current: EditCurrentState = {
    playerCount: anchor.playerCount ?? players.length,
    laneCount: null,
    pricingMode: null,
    shoes: anchorStoredLines
      .filter((l) => l.productKind === "addon_shoe" && l.squareProductId != null)
      .map((l) => ({
        squareProductId: l.squareProductId!,
        label: l.label,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
      })),
    shoeCatalog: shoeCatalog.map((p) => ({
      squareProductId: p.squareProductId,
      label: p.label,
      priceCents: p.priceCents,
    })),
    players: players.map((p) => ({
      slot: p.slot,
      name: p.name,
      shoeSize: p.shoeSize,
      bumpers: p.bumpers,
    })),
    heats: heatsMeta.map((h, index) => ({
      index,
      heatId: h.heatId ?? null,
      racer: h.racer ?? null,
      label: h.productId
        ? raceProductLabel(h.productId, h.category === "junior" ? "junior" : "adult")
        : "Race heat",
      category: h.category === "junior" ? ("junior" as const) : ("adult" as const),
      removable: true,
    })),
    durationOptions: [],
    durationMultiplier: null,
    attractions: (anchor.attractionBookings ?? []).map((a, index) => ({
      index,
      name: a.name,
      quantity: a.quantity,
      unitPriceCents: a.quantity > 0 ? Math.round((a.totalPriceDollars * 100) / a.quantity) : 0,
      timeLabel: a.timeLabel,
      editable: !!(a.bmiOrderId && a.bmiBillLineId),
    })),
    orderLines: (legSnapshots.get(anchor.id)?.lines ?? []).map((l) => ({
      uid: l.uid ?? "",
      name: l.name,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      totalCents: l.totalCents,
      // Editable only when nothing in the booking model claims this line —
      // the same rule applyOrderLineSpec enforces server-side, so the UI never
      // offers a control the engine would reject.
      editable: !!l.uid && !isEngineOwnedLine(l, anchorEngineLines),
    })),
  };

  // 4. Reprice per leg → desired order lines.
  const legs: EditPlanLeg[] = [];

  const bowlingLegPlan = async (
    leg: BowlingReservation,
    stored: StoredLine[],
    legPlayers: number,
  ): Promise<EditPlanLeg> => {
    const snap = legSnapshots.get(leg.id) ?? null;

    // Resolve the experience: needed for the legacy pricing fallback AND for
    // duration options (hourly rentals). Stamp rows resolve by slug; legacy
    // rows by the primary product — searched in the experience's ITEMS and
    // its duration-option OVERRIDE products (2h bookings book the override).
    const stamp = (leg.bookingMetadata as { bowling?: { experienceSlug?: string | null } } | null)
      ?.bowling;
    const experience = matchExperienceForRow({
      experiences: await loadExperiencesForCenter(leg.centerCode, leg.productKind),
      stampSlug: stamp?.experienceSlug ?? null,
      stored,
    });

    // Pricing resolution is only REQUIRED when the edit scales the lane line
    // (players / lanes / duration). Shoe, roster, and attraction edits carry
    // the primary unchanged, so legacy rows with unresolvable pricing still
    // take those edits instead of hard-blocking.
    const scalesPrimary =
      spec.playerCount != null || spec.laneCount != null || spec.durationOptionId != null;
    let booked: ResolvedBookedPricing;
    let carryPrimary = false;
    try {
      booked = resolveBookedPricing({
        bookingMetadata: leg.bookingMetadata ?? null,
        playerCount: legPlayers,
        lines: stored,
        experienceKind: experience?.kind ?? null,
        experienceSlug: experience?.slug ?? null,
      });
    } catch (err) {
      if (!(err instanceof EditGuardError) || scalesPrimary) throw err;
      carryPrimary = true;
      booked = {
        experienceSlug: experience?.slug ?? null,
        laneCount: Math.max(1, Math.ceil(legPlayers / 6)),
        durationMultiplier: 1,
        pricingMode: "per_person",
        source: "derived",
      };
      warnings.push({
        severity: "info",
        code: "pricing_carry",
        message:
          "booked pricing mode could not be resolved — the lane line is carried unchanged " +
          "(player/lane/duration edits are unavailable for this booking)",
      });
    }
    if (leg.id === anchor.id) {
      current.laneCount = carryPrimary ? null : booked.laneCount;
      current.pricingMode = carryPrimary ? null : booked.pricingMode;
      current.durationMultiplier = carryPrimary ? null : booked.durationMultiplier;
      current.durationOptions = carryPrimary
        ? []
        : (experience?.durationOptions ?? []).map((d) => ({
            id: d.id,
            label: d.label,
            multiplier: d.squareMultiplier,
          }));
    }

    // Duration change (hourly): resolve the target option + the primary
    // product it books (base item or the option's override product).
    let durationOption: DurationOptionFacts | null = null;
    let desiredPrimary: ProductFacts | null = null;
    if (spec.durationOptionId != null) {
      const opt = experience?.durationOptions.find((d) => d.id === spec.durationOptionId);
      if (!opt) {
        throw new EditGuardError(
          "pricing_unresolvable",
          `duration option ${spec.durationOptionId} is not offered by this experience`,
        );
      }
      durationOption = {
        id: opt.id,
        label: opt.label,
        squareMultiplier: opt.squareMultiplier,
        overrideSquareProductId: opt.overrideSquareProductId,
        overridePriceCents: opt.overridePriceCents,
        overrideCatalogObjectId: opt.overrideCatalogObjectId,
      };
      const storedPrimary = stored.find(
        (l) => l.productKind != null && ["kbf", "open", "hourly"].includes(l.productKind),
      );
      if (opt.overrideSquareProductId != null) {
        const p = productsById.get(opt.overrideSquareProductId);
        desiredPrimary = p
          ? {
              squareProductId: p.id,
              label: p.label,
              priceCents: p.priceCents,
              squareCatalogObjectId: p.squareCatalogObjectId,
              productKind: p.productKind,
            }
          : {
              squareProductId: opt.overrideSquareProductId,
              label: opt.label,
              priceCents: opt.overridePriceCents ?? 0,
              squareCatalogObjectId: opt.overrideCatalogObjectId,
              productKind: "hourly",
            };
      } else {
        // Base pricing: the experience's primary item.
        const baseItem = experience?.items.find((i) =>
          ["kbf", "open", "hourly"].includes(i.productKind),
        );
        if (baseItem) {
          desiredPrimary = {
            squareProductId: baseItem.squareProductId,
            label: baseItem.label,
            priceCents: baseItem.priceCents,
            squareCatalogObjectId: baseItem.squareCatalogObjectId,
            productKind: baseItem.productKind as ProductFacts["productKind"],
          };
        }
      }
      // Same product as booked → no swap; the multiplier does the work and a
      // discounted booked price is preserved.
      if (desiredPrimary && storedPrimary?.squareProductId === desiredPrimary.squareProductId) {
        desiredPrimary = null;
      }
    }

    // KBF roster money: rebuild the extras from the shared builder when the
    // spec provides the roster counts; the repriced bowling set then excludes
    // stored KBF-extra lines (they're order-only, not Neon product lines).
    const reprice = repriceBowling({
      booked,
      currentPlayerCount: legPlayers,
      lines: stored,
      spec: { playerCount: spec.playerCount, laneCount: spec.laneCount, shoes: spec.shoes },
      shoeCatalog,
      durationOption,
      desiredPrimary,
      carryPrimary,
    });
    warnings.push(...reprice.warnings);

    let repricedLines = reprice.lines;
    if (leg.productKind === "kbf" && spec.kbf) {
      const isVip = /vip/i.test(stored.map((l) => l.label).join(" "));
      const ymd = (leg.bookedAt ?? "").slice(0, 10);
      const extras = repriceKbfExtras({
        isVip,
        isFriday: ymd ? isFridayYmd(ymd) : false,
        counts: spec.kbf,
      });
      repricedLines = [...repricedLines, ...extras];
      warnings.push({
        severity: "info",
        code: "kbf_extras_rebuilt",
        message: "KBF adult-game / VIP upcharge lines rebuilt from the roster counts",
      });
    }

    const neonCatalogIds = new Set(
      repricedLines.map((l) => l.squareCatalogObjectId).filter(Boolean),
    );
    const neonLabels = new Set(repricedLines.map((l) => l.label));
    const storedCatalogIds = new Set(stored.map((l) => l.squareCatalogObjectId).filter(Boolean));
    const storedLabels = new Set(stored.map((l) => l.label));
    let newLines = mergeDesiredWithOrder(repricedLines, snap, (line) => {
      const byCatalog = line.catalogObjectId
        ? neonCatalogIds.has(line.catalogObjectId) || storedCatalogIds.has(line.catalogObjectId)
        : false;
      return byCatalog || neonLabels.has(line.name) || storedLabels.has(line.name);
    });

    // Attraction add-on qty changes: the lines live only on the ORDER (the
    // Neon record is the attraction_bookings JSONB), so they're adjusted on
    // the merged carryover set. BMI replace happens at execute time.
    let attractionChanges: EditPlanLeg["attractionChanges"] = null;
    if ((spec.attractions?.length ?? 0) > 0 && leg.id === anchor.id) {
      attractionChanges = [];
      for (const change of spec.attractions ?? []) {
        const booking = (anchor.attractionBookings ?? [])[change.index];
        if (!booking) {
          throw new EditGuardError(
            "plan_stale",
            `attraction index ${change.index} not on the reservation`,
          );
        }
        if (!Number.isInteger(change.quantity) || change.quantity < 0) {
          throw new EditGuardError("pricing_unresolvable", "invalid attraction quantity");
        }
        if (change.quantity === booking.quantity) continue;
        if (!booking.bmiOrderId || !booking.bmiBillLineId) {
          throw new EditGuardError(
            "bmi_line_unavailable",
            `"${booking.name}" has no BMI line ids — adjust it manually`,
          );
        }
        const unit =
          booking.quantity > 0
            ? Math.round((booking.totalPriceDollars * 100) / booking.quantity)
            : 0;
        const hit = newLines.find(
          (l) =>
            (booking.squareCatalogObjectId &&
              l.catalogObjectId === booking.squareCatalogObjectId) ||
            l.name === booking.name,
        );
        if (change.quantity === 0) {
          if (hit) {
            newLines = newLines.filter((l) => l !== hit);
          }
        } else if (hit) {
          hit.quantity = change.quantity;
          hit.totalCents = hit.unitPriceCents * hit.quantity;
        } else {
          newLines.push({
            uid: null,
            catalogObjectId: booking.squareCatalogObjectId,
            name: booking.name,
            quantity: change.quantity,
            unitPriceCents: unit,
            totalCents: unit * change.quantity,
            note: null,
          });
        }
        attractionChanges.push({
          index: change.index,
          slug: booking.slug,
          name: booking.name,
          newQuantity: change.quantity,
          oldQuantity: booking.quantity,
          unitPriceCents: unit,
          bmiOrderId: booking.bmiOrderId,
          bmiBillLineId: booking.bmiBillLineId,
        });
      }
      if (attractionChanges.length === 0) attractionChanges = null;
    }

    // Free-form day-of line edits (food, POS add-ons) by live order uid.
    newLines = applyOrderLineSpec(newLines, spec.orderLines, leg.id === anchor.id, [
      ...anchorEngineLines,
      ...repricedLines.map((l) => ({
        squareCatalogObjectId: l.squareCatalogObjectId,
        label: l.label,
      })),
    ]);

    const newTotal = snap
      ? await calculateOrderTotal(snap.locationId, newLines, snap.taxes, snap.discounts)
      : newLines.reduce((s, l) => s + l.totalCents, 0);

    return {
      reservationId: leg.id,
      productKind: leg.productKind,
      dayofOrderId: leg.squareDayofOrderId ?? null,
      orderState: snap?.state ?? null,
      orderVersion: snap?.version ?? null,
      orderLocationId: snap?.locationId ?? null,
      phase: legPhase(leg),
      oldLines: snap?.lines ?? [],
      newLines,
      oldTotalCents: snap?.totalCents ?? 0,
      newTotalCents: newTotal,
      newNeonLines: repricedLines,
      newPlayerCount: reprice.newPlayerCount,
      newLaneCount: reprice.newLaneCount,
      newDuration:
        durationOption && durationOption.squareMultiplier !== booked.durationMultiplier
          ? {
              optionId: durationOption.id,
              qamfOptionId:
                experience?.durationOptions.find((d) => d.id === durationOption.id)?.qamfOptionId ??
                0,
              multiplier: durationOption.squareMultiplier,
            }
          : null,
      resolvedStamp: carryPrimary
        ? null
        : {
            experienceSlug: booked.experienceSlug,
            laneCount: booked.laneCount,
            durationMultiplier: booked.durationMultiplier,
            pricingMode: booked.pricingMode,
          },
      removedHeats: null,
      raceAdds: null,
      attractionChanges,
    };
  };

  const raceLegPlan = async (leg: BowlingReservation): Promise<EditPlanLeg> => {
    const snap = legSnapshots.get(leg.id) ?? null;
    const legHeats = heatsFromMetadata(leg);
    const delta = repriceRaceDelta({
      heatsMeta: legHeats,
      add: spec.racers?.add ?? [],
      removeHeatIndexes: spec.racers?.removeHeatIndexes ?? [],
      resolveProduct: resolveRaceProductForCategory,
    });
    warnings.push(...delta.warnings);

    // Legacy rows (booked before heat line-tracking) have no bmiLineId, so a
    // removal would only fail INSIDE the cascade — after refunds moved. Refuse
    // at plan time; bmi-sync keeps the execute-time backstop.
    if (leg.bmiBillId) {
      const untracked = delta.removedHeats.find((r) => r.bmiLineId == null);
      if (untracked) {
        throw new EditGuardError(
          "bmi_line_unavailable",
          `"${untracked.label}" was booked before line tracking — remove it via Cancel & Rebook`,
        );
      }
    }

    // Apply the delta to the LIVE order lines. Removals match by the Square
    // CATALOG id first (order lines are catalog-linked and Square substitutes
    // its own item names — registry names never match), then by name; the
    // decrement uses the MATCHED LINE's unit price, so discounted bookings
    // refund what was actually charged, not the registry price.
    const newLines: PlanLine[] = (snap?.lines ?? []).map((l) => ({ ...l }));
    for (const removed of delta.removedHeats) {
      const hit = newLines.find(
        (l) =>
          l.quantity >= 1 &&
          ((removed.catalogObjectId && l.catalogObjectId === removed.catalogObjectId) ||
            l.name === removed.label),
      );
      if (!hit) {
        throw new EditGuardError(
          "pricing_unresolvable",
          `no order line matches removed heat "${removed.label}" — the order money can't be ` +
            "derived safely; adjust this one manually in Square",
        );
      }
      hit.quantity -= 1;
      hit.totalCents = hit.unitPriceCents * hit.quantity;
    }
    const survivors = newLines.filter((l) => l.quantity > 0);
    for (const added of delta.addedLines) {
      const existing = survivors.find(
        (l) =>
          ((added.squareCatalogObjectId && l.catalogObjectId === added.squareCatalogObjectId) ||
            l.name === added.label) &&
          l.unitPriceCents === added.unitPriceCents,
      );
      if (existing) {
        existing.quantity += added.quantity;
        existing.totalCents = existing.unitPriceCents * existing.quantity;
      } else {
        survivors.push(toPlanLine(added, null));
      }
    }

    // Free-form day-of line edits (food, POS add-ons) by live order uid. Every
    // race product name is engine-owned so the helper refuses uid edits on
    // them — racer changes must go through spec.racers, which drives BMI too.
    const finalLines = applyOrderLineSpec(survivors, spec.orderLines, leg.id === anchor.id, [
      ...anchorEngineLines,
      ...delta.addedLines.map((l) => ({
        squareCatalogObjectId: l.squareCatalogObjectId,
        label: l.label,
      })),
      ...delta.removedHeats.map((h) => ({
        squareCatalogObjectId: h.catalogObjectId,
        label: h.label,
      })),
    ]);

    const newTotal = snap
      ? await calculateOrderTotal(snap.locationId, finalLines, snap.taxes, snap.discounts)
      : finalLines.reduce((s, l) => s + l.totalCents, 0);

    return {
      reservationId: leg.id,
      productKind: leg.productKind,
      dayofOrderId: leg.squareDayofOrderId ?? null,
      orderState: snap?.state ?? null,
      orderVersion: snap?.version ?? null,
      orderLocationId: snap?.locationId ?? null,
      phase: legPhase(leg),
      oldLines: snap?.lines ?? [],
      newLines: finalLines,
      oldTotalCents: snap?.totalCents ?? 0,
      newTotalCents: newTotal,
      newNeonLines: null,
      newPlayerCount: null,
      newLaneCount: null,
      newDuration: null,
      resolvedStamp: null,
      removedHeats: delta.removedHeats.map((r) => ({
        index: r.index,
        bmiLineId: r.bmiLineId,
        label: r.label,
      })),
      raceAdds: delta.raceAdds.length > 0 ? delta.raceAdds : null,
      attractionChanges: null,
    };
  };

  if (isCombo) {
    // Combo: racer add/remove only. Per-person revenue-split lines live on
    // BOTH entity orders, so adds/removes apply comboItemizedLinesForRacers
    // deltas per entity — never race-product prices.
    if (
      spec.playerCount != null ||
      spec.laneCount != null ||
      spec.shoes != null ||
      spec.kbf != null ||
      spec.durationOptionId != null ||
      spec.attractions != null
    ) {
      throw new EditGuardError(
        "unsupported_kind",
        "combo edits support racer add/remove only (v1)",
      );
    }
    const combo: ComboSpecial | null = getComboSpecial(
      group.find((g) => g.comboSpecialId)?.comboSpecialId ?? "",
    );
    if (!combo) throw new EditGuardError("unsupported_kind", "unknown combo special");

    const raceLeg = group.find((g) => g.productKind === "race") ?? anchor;
    const comboDate =
      heatsFromMetadata(raceLeg)
        .map((h) => h.heatId)
        .filter((s): s is string => !!s)
        .sort()[0]
        ?.slice(0, 10) ?? (raceLeg.bookedAt ?? "").slice(0, 10);

    // The race leg still drives BMI heat add/remove refs.
    const raceHeats = heatsFromMetadata(raceLeg);
    const removeSet = new Set(spec.racers?.removeHeatIndexes ?? []);
    for (const index of removeSet) {
      if (!raceHeats[index]) {
        throw new EditGuardError("plan_stale", `heat index ${index} not on the reservation`);
      }
      // Same legacy-row refusal as raceLegPlan: no bmiLineId on a billed heat
      // means the BMI removal can only fail mid-cascade, after refunds moved.
      if (raceLeg.bmiBillId && raceHeats[index].bmiLineId == null) {
        throw new EditGuardError(
          "bmi_line_unavailable",
          `"${raceHeats[index].racer ?? `heat ${index}`}" was booked before line tracking — ` +
            "remove it via Cancel & Rebook",
        );
      }
    }

    // Removals must cover WHOLE racers — combo pricing is per person.
    const racerKey = (h: HeatMeta): string => h.bmiPersonId ?? h.assignedTo ?? h.racer ?? "?";
    const removedRacers = new Set<string>();
    for (const index of removeSet) removedRacers.add(racerKey(raceHeats[index]));
    for (const [index, h] of raceHeats.entries()) {
      if (removedRacers.has(racerKey(h)) && !removeSet.has(index)) {
        throw new EditGuardError(
          "unsupported_kind",
          `combo removals are per racer — select ALL of ${h.racer ?? "the racer"}'s heats`,
        );
      }
    }

    // Per-racer delta lines from the shared booking seam. Removed racers are
    // classified new/returning by whichever classification's lines exactly
    // match the live orders (a new racer's split carries the license line; a
    // returning racer's reallocates it — the unit cents differ).
    const addDelta =
      (spec.racers?.add?.length ?? 0) > 0
        ? repriceComboRacers({
            combo,
            date: comboDate,
            racers: (spec.racers?.add ?? []).map((r, i) => ({
              id: `add-${i}`,
              isNew: r.isNew ?? false,
            })),
          })
        : null;

    const legEntity = (leg: BowlingReservation): string =>
      leg.productKind === "race" || leg.productKind === "attraction"
        ? "fasttrax-fm"
        : "headpinz-fm";

    // Build mutable copies of every leg's live lines up front so removal
    // matching can consume across entities atomically.
    const legLines = new Map<number, PlanLine[]>();
    for (const leg of group) {
      const snap = legSnapshots.get(leg.id) ?? null;
      legLines.set(
        leg.id,
        (snap?.lines ?? []).map((l) => ({ ...l })),
      );
    }
    const linesForEntity = (entity: string): PlanLine[][] =>
      group.filter((g) => legEntity(g) === entity).map((g) => legLines.get(g.id) ?? []);

    const tryDecrement = (
      entity: string,
      catalogId: string | null,
      unitCents: number,
      qty: number,
      apply: boolean,
    ): boolean => {
      let remaining = qty;
      for (const lines of linesForEntity(entity)) {
        for (const l of lines) {
          if (remaining <= 0) break;
          const catalogMatch = catalogId ? l.catalogObjectId === catalogId : true;
          if (catalogMatch && l.unitPriceCents === unitCents && l.quantity >= 1) {
            const take = Math.min(remaining, l.quantity);
            if (apply) {
              l.quantity -= take;
              l.totalCents = l.unitPriceCents * l.quantity;
            }
            remaining -= take;
          }
        }
      }
      return remaining <= 0;
    };

    for (const key of removedRacers) {
      const heat = raceHeats.find((h) => racerKey(h) === key);
      const label = heat?.racer ?? key;
      let matched = false;
      for (const isNew of [true, false]) {
        const delta = repriceComboRacers({
          combo,
          date: comboDate,
          racers: [{ id: key, isNew }],
        });
        const fits = delta.byEntity.every((e) =>
          e.lines.every((l) =>
            tryDecrement(e.entity, l.squareCatalogObjectId, l.unitPriceCents, l.quantity, false),
          ),
        );
        if (fits) {
          for (const e of delta.byEntity) {
            for (const l of e.lines) {
              tryDecrement(e.entity, l.squareCatalogObjectId, l.unitPriceCents, l.quantity, true);
            }
          }
          matched = true;
          break;
        }
      }
      if (!matched) {
        throw new EditGuardError(
          "unsupported_kind",
          `the live orders don't carry matchable combo lines for ${label} — handle this one manually in Square`,
        );
      }
    }

    if (addDelta) {
      for (const e of addDelta.byEntity) {
        const targetLeg = group.find((g) => legEntity(g) === e.entity);
        if (!targetLeg) {
          throw new EditGuardError(
            "unsupported_kind",
            `no ${e.entity} order in this money group for the added racer's lines`,
          );
        }
        const lines = legLines.get(targetLeg.id)!;
        for (const l of e.lines) {
          const existing = lines.find(
            (x) =>
              x.catalogObjectId === l.squareCatalogObjectId &&
              x.unitPriceCents === l.unitPriceCents,
          );
          if (existing) {
            existing.quantity += l.quantity;
            existing.totalCents = existing.unitPriceCents * existing.quantity;
          } else {
            lines.push(toPlanLine(l, null));
          }
        }
      }
    }

    for (const leg of group) {
      const snap = legSnapshots.get(leg.id) ?? null;
      const survivors = (legLines.get(leg.id) ?? []).filter((l) => l.quantity > 0);
      const newTotal = snap
        ? await calculateOrderTotal(snap.locationId, survivors, snap.taxes, snap.discounts)
        : survivors.reduce((s, l) => s + l.totalCents, 0);
      const legRemoved =
        leg.id === raceLeg.id
          ? [...removeSet].map((index) => ({
              index,
              bmiLineId: raceHeats[index]?.bmiLineId ?? null,
              label: raceHeats[index]?.racer ?? `heat ${index}`,
            }))
          : null;
      legs.push({
        reservationId: leg.id,
        productKind: leg.productKind,
        dayofOrderId: leg.squareDayofOrderId ?? null,
        orderState: snap?.state ?? null,
        orderVersion: snap?.version ?? null,
        orderLocationId: snap?.locationId ?? null,
        phase: legPhase(leg),
        oldLines: snap?.lines ?? [],
        newLines: survivors,
        oldTotalCents: snap?.totalCents ?? 0,
        newTotalCents: newTotal,
        newNeonLines: null,
        newPlayerCount: null,
        newLaneCount: null,
        newDuration: null,
        resolvedStamp: null,
        removedHeats: legRemoved,
        raceAdds: null,
        attractionChanges: null,
      });
    }
  } else if (anchor.productKind === "race" || anchor.productKind === "attraction") {
    legs.push(await raceLegPlan(anchor));
  } else {
    legs.push(await bowlingLegPlan(anchor, anchorStoredLines, current.playerCount));
  }

  // 5. Money facts + diff.
  const diffCents = legs.reduce((s, l) => s + (l.newTotalCents - l.oldTotalCents), 0);

  let giftCard: EditPlan["giftCard"] = null;
  if (anchor.squareGiftCardId) {
    try {
      const gc = await fetchGiftCardFacts(anchor.squareGiftCardId);
      giftCard = { id: gc.id, gan: gc.gan, balanceCents: gc.balanceCents, state: gc.state };
    } catch {
      warnings.push({
        severity: "warning",
        code: "gift_card_unreadable",
        message: "deposit gift card could not be fetched — verify before executing",
      });
    }
  }

  // Two amounts, not one — they diverge legitimately on gap-comped rows.
  //
  // At lane-open, a deposit computed pre-tax can fall a few cents short of the
  // tax-inclusive day-of total; processLaneOpen auto-comps that gap onto the
  // internal gift card (ADJUST_INCREMENT / COMPLIMENTARY, bounded to 200¢ —
  // lib/bowling-lane-open.ts). The day-of payment therefore exceeds what the
  // guest's deposit tenders can ever take back.
  //
  //   gcDecrementCents — everything the day-of refund credits back to the
  //                      internal card. ALL of it must die, or the comp share
  //                      survives as spendable value.
  //   guestOwedCents   — capped at the deposit tenders' un-refunded capacity.
  //                      The comp share has no guest destination (unlinked
  //                      refunds are not enabled), so it returns to the house.
  //
  // An asymmetry larger than the gap-comp bound means unknown manual activity:
  // refuse rather than guess.
  let guestOwedCents = diffCents < 0 ? -diffCents : 0;
  const gcDecrementCents = guestOwedCents;
  if (diffCents < 0 && anchor.squareDepositOrderId) {
    try {
      const deposit = await fetchOrderFacts(anchor.squareDepositOrderId);
      let capacity = 0;
      for (const t of deposit.tenders) {
        const pay = await fetchPaymentFacts(t.paymentId);
        capacity += Math.max(0, pay.amountCents - pay.refundedCents);
      }
      if (capacity < gcDecrementCents) {
        const shortfall = gcDecrementCents - capacity;
        if (shortfall > GAP_COMP_MAX_CENTS) {
          throw new EditGuardError(
            "pricing_unresolvable",
            `refund of ${gcDecrementCents}¢ exceeds refundable deposit capacity (${capacity}¢) by ` +
              `${shortfall}¢ — more than the ${GAP_COMP_MAX_CENTS}¢ lane-open comp allowance, so ` +
              `something else moved this money. Reconcile in Square first.`,
          );
        }
        guestOwedCents = capacity;
        warnings.push({
          severity: "warning",
          code: "gap_comp_reversal",
          message:
            `${shortfall}¢ of this refund was a lane-open courtesy comp and has no card to return ` +
            `to — the guest receives ${guestOwedCents}¢ and the gift card is cleared of all ` +
            `${gcDecrementCents}¢.`,
        });
      }
    } catch (err) {
      if (err instanceof EditGuardError) throw err;
      warnings.push({
        severity: "warning",
        code: "deposit_capacity_unknown",
        message: "deposit tenders could not be read — refund capacity unverified",
      });
    }
  }

  let chargeCard: EditPlan["chargeCard"] = null;
  if (diffCents > 0 && anchor.squareCustomerId) {
    try {
      const card = await getChargeableCard(anchor.squareCustomerId, anchor.squareDepositOrderId);
      if (card) chargeCard = { cardId: card.cardId, brand: card.brand, last4: card.last4 };
    } catch {
      /* vault unavailable → treated as no card on file */
    }
  }

  const settlement: EditPlan["settlement"] =
    diffCents > 0 ? "charge" : diffCents < 0 ? (req.settlement ?? "card_refund") : "none";
  if (diffCents < 0 && !req.settlement) {
    warnings.push({
      severity: "info",
      code: "settlement_defaulted",
      message: "no refund destination chosen — defaulting to original payment",
    });
  }
  if (diffCents > 0 && !chargeCard && req.paymentSource?.kind !== "payment_link") {
    warnings.push({
      severity: "warning",
      code: "no_card_on_file",
      message: "price increases but no card is on file — send the guest a payment link",
    });
  }

  // 6. Steps.
  const steps: EditStep[] = [{ kind: "audit_start", fatal: true }];
  const lanesChanged = legs.some(
    (l) =>
      l.newLaneCount != null && current.laneCount != null && l.newLaneCount !== current.laneCount,
  );
  const durationChanged = legs.some((l) => l.newDuration != null);
  const attractionsChanged = legs.some((l) => (l.attractionChanges?.length ?? 0) > 0);
  const playersChanged =
    legs.some((l) => l.newPlayerCount != null && l.newPlayerCount !== current.playerCount) ||
    (spec.players?.length ?? 0) > 0;

  if (durationChanged && phase !== "pre") {
    // The lane block's length is a physical booking — only changeable before
    // anyone is on the lanes (same rule as lane-count changes).
    throw new EditGuardError("lane_change_mid_session", "duration changes are pre-check-in only");
  }
  if (attractionsChanged && phase !== "pre") {
    // The BMI attraction line replace assumes an unopened session.
    throw new EditGuardError("mid_session_unsupported", "attraction changes are pre-check-in only");
  }

  // A combo group can be anchored from either leg — resolve the QAMF/BMI
  // capabilities across the WHOLE money group, not just the clicked row.
  const groupQamfId =
    anchor.qamfReservationId ?? group.find((g) => g.qamfReservationId)?.qamfReservationId;
  const groupBmiBillId = anchor.bmiBillId ?? group.find((g) => g.bmiBillId)?.bmiBillId;

  if (phase === "pre") {
    // External capacity FIRST (fatal) — never charge for capacity we can't get.
    // Duration changes rebook too: QAMF has no time-length mutation, and the
    // new Time option id only applies on a fresh reservation.
    if ((lanesChanged || durationChanged) && groupQamfId) {
      steps.push({ kind: "qamf_rebook", fatal: true, target: groupQamfId });
    }
    if (changesRaceHeats && (spec.racers?.add?.length ?? 0) > 0 && groupBmiBillId) {
      steps.push({ kind: "bmi_add_heats", fatal: true, target: groupBmiBillId });
    }
    if (attractionsChanged) {
      // Capacity + entitlement replace on the attraction's own BMI bill —
      // fatal and BEFORE money (an increase must actually have slot space).
      steps.push({ kind: "bmi_attractions", fatal: true });
    }
    if (diffCents > 0) {
      steps.push({ kind: "charge_topup", fatal: true, amountCents: diffCents });
      if (giftCard) {
        steps.push({
          kind: "load_gift_card",
          fatal: true,
          target: giftCard.id,
          amountCents: diffCents,
        });
      }
    } else if (diffCents < 0) {
      // Same two-amount split as the post-payment phases. In PRE these are
      // normally equal (nothing has been comped onto the card yet); they can
      // still diverge when a prior refund ate the deposit's capacity.
      if (settlement === "store_credit") {
        steps.push({ kind: "issue_store_credit", fatal: true, amountCents: guestOwedCents });
      } else {
        steps.push({ kind: "refund_tender", fatal: true, amountCents: guestOwedCents });
      }
      if (giftCard) {
        steps.push({
          kind: "adjust_gift_card_down",
          fatal: true,
          target: giftCard.id,
          amountCents: gcDecrementCents,
        });
      }
    }
    for (const leg of legs) {
      if (leg.dayofOrderId && legLinesChanged(leg)) {
        steps.push({
          kind: "update_dayof_order",
          fatal: true,
          target: leg.dayofOrderId,
          amountCents: leg.newTotalCents - leg.oldTotalCents,
        });
      }
    }
    steps.push({ kind: "neon_commit", fatal: true });
    if (changesRaceHeats && (spec.racers?.removeHeatIndexes?.length ?? 0) > 0 && groupBmiBillId) {
      steps.push({ kind: "bmi_remove_lines", fatal: false, target: groupBmiBillId });
    }
    if ((playersChanged || lanesChanged || (isCombo && changesRaceHeats)) && groupQamfId) {
      steps.push({ kind: "qamf_set_players", fatal: false, target: groupQamfId });
      steps.push({ kind: "qamf_memo", fatal: false, target: groupQamfId });
    }
  } else if (phase === "mid") {
    if (diffCents > 0) {
      steps.push({
        kind: "charge_dayof_order",
        fatal: true,
        target: legs[0].dayofOrderId ?? undefined,
        amountCents: diffCents,
      });
    } else if (diffCents < 0) {
      // Refunding the WHOLE of a lane-open order leaves it OPEN with a balance
      // due: bowling-order-complete skips balance-due orders, so it would
      // never close and never reach QuickBooks, and the cancel cascade refuses
      // to cancel a tendered order. That end state has an owner — the cancel
      // cascade — so route there instead of stranding the order here.
      if (legs.every((l) => l.newTotalCents === 0)) {
        throw new EditGuardError(
          "full_refund_use_cancel",
          "This refunds the entire visit. Use Cancel instead — it settles the money and closes " +
            "the order properly; an edit would leave the day-of order open with a balance due.",
        );
      }
      // The day-of leg reverses everything the order was paid — including any
      // lane-open comp — so it moves gcDecrementCents.
      steps.push({
        kind: "refund_dayof_payment",
        fatal: true,
        target: anchor.dayofPaymentId ?? undefined,
        amountCents: gcDecrementCents,
      });
      // The guest leg is capped at what their tenders can take back.
      if (settlement === "store_credit") {
        steps.push({ kind: "issue_store_credit", fatal: true, amountCents: guestOwedCents });
      } else {
        steps.push({ kind: "refund_tender", fatal: true, amountCents: guestOwedCents });
      }
      if (giftCard) {
        // Square credits the day-of refund back to the internal card
        // asynchronously — decrementing before it lands reads a stale balance,
        // no-ops, and leaves the refunded value spendable (2026-07-27 probe).
        steps.push({ kind: "wait_gc_credit", fatal: true, target: giftCard.id });
        steps.push({
          kind: "adjust_gift_card_down",
          fatal: true,
          target: giftCard.id,
          amountCents: gcDecrementCents,
        });
      }
    }
    for (const leg of legs) {
      if (leg.dayofOrderId && legLinesChanged(leg)) {
        steps.push({
          kind: "update_dayof_order",
          fatal: true,
          target: leg.dayofOrderId,
          amountCents: leg.newTotalCents - leg.oldTotalCents,
        });
      }
    }
    steps.push({ kind: "neon_commit", fatal: true });
    if (playersChanged && anchor.qamfReservationId) {
      steps.push({ kind: "qamf_set_players", fatal: false, target: anchor.qamfReservationId });
    }
  } else {
    // post_complete: full refund → rebuild → repay → complete. QAMF/BMI NEVER.
    warnings.push({
      severity: "manager",
      code: "post_complete_no_external_sync",
      message:
        "Day-of order already closed — QAMF and BMI will NOT be updated. Adjust Conqueror/BMI manually.",
    });
    // A COMPLETED order's lines are frozen, so a pure price DECREASE has two
    // possible shapes:
    //
    //   money-only  — partial-refund the day-of payment, settle the guest,
    //                 decrement the card. The order keeps its lines and the
    //                 refund objects tell the story.
    //   rebuild     — refund every tender in full, build a replacement order,
    //                 repay it from the gift card, complete it.
    //
    // Money-only is preferred for item refunds: no order-id swap (which breaks
    // the QBO race-catalog mapping), no re-issued loyalty/discounts, far less
    // accounting noise, and the refund is visible on the original payment. The
    // rebuild only earns its cost when the LINES genuinely have to change,
    // which for a frozen order means an increase.
    const linesMustChange = diffCents > 0;
    const fullRefund = diffCents < 0 && legs.every((l) => l.newTotalCents === 0);

    if (linesMustChange) {
      for (const leg of legs) {
        if (leg.dayofOrderId) {
          steps.push({ kind: "refund_dayof_order", fatal: true, target: leg.dayofOrderId });
        }
      }
      steps.push({ kind: "charge_topup", fatal: true, amountCents: diffCents });
      if (giftCard) {
        steps.push({
          kind: "load_gift_card",
          fatal: true,
          target: giftCard.id,
          amountCents: diffCents,
        });
      }
      for (const leg of legs) {
        steps.push({ kind: "rebuild_dayof_order", fatal: true, amountCents: leg.newTotalCents });
        steps.push({ kind: "pay_dayof_order", fatal: true, amountCents: leg.newTotalCents });
        steps.push({ kind: "complete_dayof_order", fatal: true });
      }
    } else if (diffCents < 0) {
      // Money-only. Reverse the guest's share of the day-of payment rather
      // than every tender, so nothing has to be rebuilt or repaid.
      steps.push({
        kind: "refund_dayof_payment",
        fatal: true,
        target: anchor.dayofPaymentId ?? undefined,
        amountCents: gcDecrementCents,
      });
      if (settlement === "store_credit") {
        steps.push({ kind: "issue_store_credit", fatal: true, amountCents: guestOwedCents });
      } else {
        steps.push({ kind: "refund_tender", fatal: true, amountCents: guestOwedCents });
      }
      if (giftCard) {
        // The credit posts asynchronously — never decrement before it lands.
        steps.push({ kind: "wait_gc_credit", fatal: true, target: giftCard.id });
        steps.push({
          kind: "adjust_gift_card_down",
          fatal: true,
          target: giftCard.id,
          amountCents: gcDecrementCents,
        });
      }
      if (fullRefund) {
        // Refunding everything on a closed order. A zero-line rebuild is
        // meaningless, so emit no rebuild at all — the order stays COMPLETED
        // carrying its refunds. The row must NOT become 'cancelled': the guest
        // was here and the visit happened.
        warnings.push({
          severity: "warning",
          code: "full_refund_no_rebuild",
          message:
            "Refunding the entire order. It stays closed with the refund attached and the " +
            "reservation stays as-is — use Cancel instead if the booking should be voided.",
        });
      }
    }
    steps.push({ kind: "neon_commit", fatal: true });
    steps.push({ kind: "notify", fatal: false, detail: "teams_manager_alert" });
  }
  steps.push({ kind: "notify", fatal: false });

  if (diffCents > 0 && req.paymentSource?.kind === "payment_link") {
    // The charge step waits on the guest — flag it in the step list.
    const idx = steps.findIndex(
      (s) => s.kind === "charge_topup" || s.kind === "charge_dayof_order",
    );
    if (idx >= 0)
      steps.splice(idx, 0, { kind: "await_payment_link", fatal: true, amountCents: diffCents });
  }

  const noChanges =
    diffCents === 0 &&
    !legs.some(legLinesChanged) &&
    !playersChanged &&
    !lanesChanged &&
    !durationChanged &&
    !attractionsChanged &&
    !changesRaceHeats;
  if (noChanges) throw new EditGuardError("no_changes");

  // 7. Seal.
  const hash = hashPlan({
    anchorId: anchor.id,
    legIds,
    phase,
    spec,
    settlement,
    diffCents,
    legs: legs.map((l) => ({
      id: l.reservationId,
      order: l.dayofOrderId,
      oldTotal: l.oldTotalCents,
      newTotal: l.newTotalCents,
      old: l.oldLines,
      new: l.newLines,
    })),
    steps: steps.map((s) => ({ k: s.kind, t: s.target ?? null, a: s.amountCents ?? null })),
  });

  return {
    anchorId: anchor.id,
    legIds,
    isCombo,
    phase,
    spec,
    legs,
    diffCents,
    guestOwedCents,
    gcDecrementCents,
    settlement,
    chargeCard,
    giftCard,
    steps,
    warnings,
    current,
    planHash: hash,
  };
};

/** A line the booking model owns, matched by catalog id or exact name. */
interface EngineOwnedLine {
  squareCatalogObjectId?: string | null;
  label: string;
}

/**
 * True when a live order line belongs to the booking itself (experience,
 * shoes, fees, attraction add-ons, race products) rather than to something
 * rung up outside the engine. Shared by the planner's `current.orderLines`
 * (so the UI only offers valid controls) and applyOrderLineSpec (the actual
 * enforcement) — one rule, no drift between what staff see and what executes.
 */
const isEngineOwnedLine = (
  line: { catalogObjectId?: string | null; name: string },
  engineLines: EngineOwnedLine[],
): boolean =>
  engineLines.some(
    (e) =>
      (!!line.catalogObjectId && e.squareCatalogObjectId === line.catalogObjectId) ||
      e.label === line.name,
  );

/**
 * Apply `spec.orderLines` (desired quantity per LIVE order line uid) to a
 * leg's merged line set. Quantity 0 removes the line.
 *
 * This is the only way to touch lines the booking engine does not model —
 * food from the day-of route, POS add-ons — which is exactly what a
 * post-check-in refund is usually about ("they returned the pizza").
 *
 * Engine-owned lines are refused: the primary experience, shoes, and race
 * products carry roster / QAMF / BMI meaning, so editing them by uid would
 * move the money without moving the booking. Those go through playerCount,
 * shoes, racers, durationOptionId instead.
 */
const applyOrderLineSpec = (
  lines: PlanLine[],
  wanted: Record<string, number> | undefined,
  isAnchorLeg: boolean,
  engineLines: EngineOwnedLine[],
): PlanLine[] => {
  if (!wanted || Object.keys(wanted).length === 0 || !isAnchorLeg) return lines;

  let out = lines;

  for (const [uid, qty] of Object.entries(wanted)) {
    if (!Number.isInteger(qty) || qty < 0) {
      throw new EditGuardError("pricing_unresolvable", `invalid quantity for order line ${uid}`);
    }
    const hit = out.find((l) => l.uid === uid);
    if (!hit) {
      // The uid came from the dry-run's snapshot of the live order; missing it
      // means the order moved underneath us.
      throw new EditGuardError(
        "plan_stale",
        `order line ${uid} is no longer on the day-of order — re-open the editor`,
      );
    }
    if (isEngineOwnedLine(hit, engineLines)) {
      throw new EditGuardError(
        "pricing_unresolvable",
        `"${hit.name}" is part of the booking itself — change it with the players, shoes, or ` +
          `racers fields so the reservation and the money stay in step`,
      );
    }
    if (qty === 0) {
      out = out.filter((l) => l !== hit);
    } else {
      hit.quantity = qty;
      hit.totalCents = hit.unitPriceCents * qty;
    }
  }
  return out;
};

const legLinesChanged = (leg: EditPlanLeg): boolean => {
  if (leg.oldLines.length !== leg.newLines.length) return true;
  const key = (l: PlanLine) => `${l.catalogObjectId ?? l.name}|${l.quantity}|${l.unitPriceCents}`;
  const olds = leg.oldLines.map(key).sort();
  const news = leg.newLines.map(key).sort();
  return olds.some((v, i) => v !== news[i]);
};
