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
  getBowlingExperiences,
  getBowlingSquareProducts,
  getReservationPlayersWithShoeAllowance,
  listCancelGroupReservations,
  type BowlingExperienceWithDetails,
  type BowlingReservation,
  type BowlingSquareProduct,
} from "@/lib/bowling-db";
import { hasOpenEditEvent } from "@/lib/reservation-edit-log";
import { fetchGiftCardFacts, sq } from "~/features/cancellation/square-actions";
import { resolveCenter } from "~/features/cancellation/centers";
import { getComboSpecial, type ComboSpecial } from "~/features/combos/combo-specials";
import { getRaceProductById } from "~/features/booking/service/race-products";
import { isFridayYmd } from "~/features/booking/service/kbf-pricing";
import { getChargeableCard } from "~/features/card-vault";

import { assertEditable, selectPhase, type SquareOrderState } from "./guards";
import { planHash as hashPlan } from "./hash";
import {
  repriceBowling,
  repriceComboRacers,
  repriceKbfExtras,
  repriceRaceDelta,
  resolveBookedPricing,
  type ResolvedBookedPricing,
} from "./reprice";
import {
  EditGuardError,
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
  /** Race legs: metadata heats removed / racers added (execution inputs). */
  removedHeats: Array<{ index: number; bmiLineId: string | null; label: string }> | null;
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
    removable: boolean;
  }>;
}

export interface EditPlan {
  anchorId: number;
  legIds: number[];
  isCombo: boolean;
  phase: EditPhase;
  spec: EditSpec;
  legs: EditPlanLeg[];
  /** Σ new − Σ old across the money group (tax-inclusive, cents). */
  diffCents: number;
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

const raceProductPriceCents = (productId: string, category: "adult" | "junior"): number | null => {
  const p = getRaceProductById(productId);
  if (!p) return null;
  // v1: added racers must match the heat product's own category — cross-
  // category adds need a different product id (book via the wizard instead).
  if (p.category !== category) return null;
  return Math.round(p.price * 100);
};

const raceProductLabel = (productId: string, category: "adult" | "junior"): string => {
  const p = getRaceProductById(productId);
  return p ? p.name : `Race product ${productId} (${category})`;
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
  const centerProducts = await getBowlingSquareProducts(anchor.centerCode);
  const productsById = new Map(centerProducts.map((p) => [p.id, p]));
  const shoeCatalog: ProductFacts[] = centerProducts
    .filter((p) => p.productKind === "addon_shoe")
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
      removable: true,
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

    // Resolve booked pricing (stamp first, legacy experience fallback).
    let experience: BowlingExperienceWithDetails | null = null;
    const stampMissing = !(leg.bookingMetadata as { bowling?: unknown } | undefined)?.bowling;
    if (stampMissing) {
      const primary = stored.find(
        (l) => l.productKind != null && ["kbf", "open", "hourly"].includes(l.productKind),
      );
      if (primary?.squareProductId != null) {
        const centerSlug = resolveCenter(leg.centerCode, leg.productKind).slug;
        const experiences = await getBowlingExperiences(centerSlug);
        experience =
          experiences.find((e) =>
            e.items.some((i) => i.squareProductId === primary.squareProductId),
          ) ?? null;
      }
    }
    const booked: ResolvedBookedPricing = resolveBookedPricing({
      bookingMetadata: leg.bookingMetadata ?? null,
      playerCount: legPlayers,
      lines: stored,
      experienceKind: experience?.kind ?? null,
      experienceSlug: experience?.slug ?? null,
    });
    if (leg.id === anchor.id) {
      current.laneCount = booked.laneCount;
      current.pricingMode = booked.pricingMode;
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
    const newLines = mergeDesiredWithOrder(repricedLines, snap, (line) => {
      const byCatalog = line.catalogObjectId
        ? neonCatalogIds.has(line.catalogObjectId) || storedCatalogIds.has(line.catalogObjectId)
        : false;
      return byCatalog || neonLabels.has(line.name) || storedLabels.has(line.name);
    });

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
      removedHeats: null,
    };
  };

  const raceLegPlan = async (leg: BowlingReservation): Promise<EditPlanLeg> => {
    const snap = legSnapshots.get(leg.id) ?? null;
    const legHeats = heatsFromMetadata(leg);
    const delta = repriceRaceDelta({
      heatsMeta: legHeats,
      add: spec.racers?.add ?? [],
      removeHeatIndexes: spec.racers?.removeHeatIndexes ?? [],
      productPriceCents: raceProductPriceCents,
      productLabel: raceProductLabel,
    });
    warnings.push(...delta.warnings);

    // Apply the delta to the LIVE order lines: removals decrement matching
    // lines by 1 unit each; additions append.
    const newLines: PlanLine[] = (snap?.lines ?? []).map((l) => ({ ...l }));
    for (const removed of delta.removedHeats) {
      const hit = newLines.find((l) => l.name === removed.label && l.quantity >= 1);
      if (!hit) {
        warnings.push({
          severity: "warning",
          code: "race_line_unmatched",
          message: `no order line found for removed heat "${removed.label}" — order money unchanged for it`,
        });
        continue;
      }
      hit.quantity -= 1;
      hit.totalCents = hit.unitPriceCents * hit.quantity;
    }
    const survivors = newLines.filter((l) => l.quantity > 0);
    for (const added of delta.addedLines) {
      const existing = survivors.find(
        (l) => l.name === added.label && l.unitPriceCents === added.unitPriceCents,
      );
      if (existing) {
        existing.quantity += added.quantity;
        existing.totalCents = existing.unitPriceCents * existing.quantity;
      } else {
        survivors.push(toPlanLine(added, null));
      }
    }

    const newTotal = snap
      ? await calculateOrderTotal(snap.locationId, survivors, snap.taxes, snap.discounts)
      : survivors.reduce((s, l) => s + l.totalCents, 0);

    return {
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
      removedHeats: delta.removedHeats.map((r) => ({
        index: r.index,
        bmiLineId: r.bmiLineId,
        label: r.label,
      })),
    };
  };

  if (isCombo) {
    // Combo v1: racer add/remove only, delta-applied per entity order.
    if (
      spec.playerCount != null ||
      spec.laneCount != null ||
      spec.shoes != null ||
      spec.kbf != null
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
    if (changesRaceHeats && (spec.racers?.add?.length ?? 0) > 0) {
      // Validate the roster math via the shared seam (throws on empty/no split).
      repriceComboRacers({
        combo,
        date: (anchor.bookedAt ?? "").slice(0, 10),
        racers: (spec.racers?.add ?? []).map((r, i) => ({
          id: `add-${i}`,
          isNew: r.isNew ?? false,
        })),
      });
    }
    // v1 combo planning uses the race-delta mechanics per leg (per-person
    // combo lines live on both orders; PR 10 refines removal matching).
    for (const leg of group) {
      legs.push(await raceLegPlan(leg));
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
  const playersChanged =
    legs.some((l) => l.newPlayerCount != null && l.newPlayerCount !== current.playerCount) ||
    (spec.players?.length ?? 0) > 0;

  if (phase === "pre") {
    // External capacity FIRST (fatal) — never charge for capacity we can't get.
    if (lanesChanged && anchor.qamfReservationId) {
      steps.push({ kind: "qamf_rebook", fatal: true, target: anchor.qamfReservationId });
    }
    if (changesRaceHeats && (spec.racers?.add?.length ?? 0) > 0 && anchor.bmiBillId) {
      steps.push({ kind: "bmi_add_heats", fatal: true, target: anchor.bmiBillId });
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
      if (settlement === "store_credit") {
        steps.push({ kind: "issue_store_credit", fatal: true, amountCents: -diffCents });
      } else {
        steps.push({ kind: "refund_tender", fatal: true, amountCents: -diffCents });
      }
      if (giftCard) {
        steps.push({
          kind: "adjust_gift_card_down",
          fatal: true,
          target: giftCard.id,
          amountCents: -diffCents,
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
    if (changesRaceHeats && (spec.racers?.removeHeatIndexes?.length ?? 0) > 0 && anchor.bmiBillId) {
      steps.push({ kind: "bmi_remove_lines", fatal: false, target: anchor.bmiBillId });
    }
    if ((playersChanged || lanesChanged) && anchor.qamfReservationId) {
      steps.push({ kind: "qamf_set_players", fatal: false, target: anchor.qamfReservationId });
      steps.push({ kind: "qamf_memo", fatal: false, target: anchor.qamfReservationId });
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
      steps.push({
        kind: "refund_dayof_payment",
        fatal: true,
        target: anchor.dayofPaymentId ?? undefined,
        amountCents: -diffCents,
      });
      if (settlement === "store_credit") {
        steps.push({ kind: "issue_store_credit", fatal: true, amountCents: -diffCents });
      } else {
        steps.push({ kind: "refund_tender", fatal: true, amountCents: -diffCents });
      }
      if (giftCard) {
        steps.push({
          kind: "adjust_gift_card_down",
          fatal: true,
          target: giftCard.id,
          amountCents: -diffCents,
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
    for (const leg of legs) {
      if (leg.dayofOrderId) {
        steps.push({ kind: "refund_dayof_order", fatal: true, target: leg.dayofOrderId });
      }
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
      if (settlement === "store_credit") {
        steps.push({ kind: "issue_store_credit", fatal: true, amountCents: -diffCents });
      } else {
        steps.push({ kind: "refund_tender", fatal: true, amountCents: -diffCents });
      }
      if (giftCard) {
        steps.push({
          kind: "adjust_gift_card_down",
          fatal: true,
          target: giftCard.id,
          amountCents: -diffCents,
        });
      }
    }
    for (const leg of legs) {
      steps.push({ kind: "rebuild_dayof_order", fatal: true, amountCents: leg.newTotalCents });
      steps.push({ kind: "pay_dayof_order", fatal: true, amountCents: leg.newTotalCents });
      steps.push({ kind: "complete_dayof_order", fatal: true });
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
    settlement,
    chargeCard,
    giftCard,
    steps,
    warnings,
    current,
    planHash: hash,
  };
};

const legLinesChanged = (leg: EditPlanLeg): boolean => {
  if (leg.oldLines.length !== leg.newLines.length) return true;
  const key = (l: PlanLine) => `${l.catalogObjectId ?? l.name}|${l.quantity}|${l.unitPriceCents}`;
  const olds = leg.oldLines.map(key).sort();
  const news = leg.newLines.map(key).sort();
  return olds.some((v, i) => v !== news[i]);
};
