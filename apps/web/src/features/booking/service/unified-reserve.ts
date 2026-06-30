/**
 * Unified reserve service — ONE Square Order per session.
 *
 * Handles mixed carts (bowling + racing + attractions) with a single
 * Square day-of order, one deposit charge, then fans out backend
 * confirmations to QAMF (bowling) and BMI (race/attraction).
 *
 * Per restructuring rules: business logic lives here, API route is a thin shell.
 */
import { randomBytes } from "crypto";
import { buildGanPrefix } from "@/lib/gan";
import { createDepositAndCharge } from "./deposit";
import { confirmBmiPayment, bmiBillIsLive } from "./bmi-confirm";
import { reserveBaseKey } from "./reserve-idempotency";
import {
  createReservation,
  getReservation,
  setReservationCustomer,
  setReservationStatus,
  patchReservation,
  setLanePlayers,
  extendReservation,
} from "@/lib/qamf-bowling";
import {
  lookupCatalogId,
  lookupCatalogIdByName,
  LOCATION_TAX,
  SQUARE_LOCATIONS,
} from "../data/square-catalog-map";
import { getRaceProductById } from "./race-products";
import { raceUsesZeroBmiModel } from "./race";
import { buildRaceChargeLines } from "./checkout";
import { promoFactor } from "./promo-pricing";
import { recordRedemption, getDiscountCodeByCode } from "~/features/discount-codes";
import { activeComboSpecial, comboOrderGroups } from "~/features/combos/combo-pricing";
import { getComboSpecial } from "~/features/combos/combo-specials";
import { wallClockMs } from "~/features/combos/combo-itinerary";
import { notifyComboBooked } from "~/features/combos/combo-notify";
import { redemptionsFromSession, redeemedHeatSet } from "../data/race-credits";
import { validateCreditRedemptions, deductCreditRedemptions } from "./race-credit-redeem";
import {
  insertBowlingReservation,
  updateBowlingReservationShortCode,
  findReusableReservation,
  getBowlingReservationByBillId,
  updateBowlingReservationConfirmed,
  updateBowlingReservationConfirmFailed,
  updateBowlingReservationSquareIds,
  type ReservationProductKind,
} from "@/lib/bowling-db";
import { shortenUrl } from "@/lib/short-url";
import type {
  BookingSession,
  BowlingItem,
  KbfItem,
  RaceItem,
  AttractionItem,
} from "../state/types";
import type { ContactInfo } from "../types";
import redis from "@/lib/redis";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";
const BOOKING_FEE_CATALOG_ID = "7VKAFU3HDPRSKY7ZB6CKXTRW";

function sqHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

// ── Input / Output types ──────────────────────────────────────────────

export interface UnifiedReserveInput {
  session: BookingSession;
  contact: ContactInfo;
  cardSourceId?: string;
  giftCardNonce?: string;
  squareCustomerId?: string;
  loyaltyAccountId?: string;
  rewardTierId?: string;
  rewardDiscountCents?: number;
}

export interface UnifiedReserveResult {
  neonIds: number[];
  shortCodes: string[];
  qamfReservationIds: string[];
  bmiReservationNumber: string | null;
  bmiReservationCode: string | null;
  squareDayofOrderId: string;
  giftCardGan: string | null;
  depositCents: number;
  totalCents: number;
}

// ── Helpers ───────────────────────────────────────────────────────────

type BowlingLikeItem = BowlingItem | KbfItem;

function isBowlingLike(item: { kind: string }): item is BowlingLikeItem {
  return item.kind === "bowling" || item.kind === "kbf";
}

// FastTrax-operated attractions. Everything else attraction-wise (gel blaster,
// laser tag, shuffly) is HeadPinz. Race is always FastTrax. Keeps the two
// Fort-Myers entities' Square revenue separate.
const FASTTRAX_ATTRACTION_SLUGS = new Set<string>(["duck-pin"]);

function resolveLocationId(session: BookingSession): string {
  // Route the Square day-of order to the entity that OWNS the products:
  //   HeadPinz (FM/Naples by center) — bowling, KBF, gel blaster, laser tag, shuffly
  //   FastTrax FM                    — race, duck pin
  // Previously ONLY bowling routed to HeadPinz and everything else fell through
  // to FastTrax, so standalone gel/laser/Naples attractions leaked into the
  // FastTrax entity's Square account.
  const hasHeadpinzProduct = session.items.some(
    (i) =>
      isBowlingLike(i) ||
      (i.kind === "attraction" && !FASTTRAX_ATTRACTION_SLUGS.has((i as AttractionItem).slug ?? "")),
  );
  if (hasHeadpinzProduct) {
    return session.center === "naples"
      ? SQUARE_LOCATIONS.HEADPINZ_NAP
      : SQUARE_LOCATIONS.HEADPINZ_FM;
  }
  return SQUARE_LOCATIONS.FASTTRAX_FM;
}

function resolveBmiClientKey(session: BookingSession): string {
  return session.center === "naples" ? "headpinznaples" : "headpinzftmyers";
}

interface SquareLineItem {
  name: string;
  quantity: string;
  catalogObjectId?: string;
  basePriceMoney?: { amount: number; currency: "USD" };
  note?: string;
}

// ── Build combined line items from all session items ──────────────────

function buildCombinedLineItems(session: BookingSession): {
  sqLineItems: SquareLineItem[];
  depositPct: number;
  promoSavingsCents: number;
} {
  const sqLineItems: SquareLineItem[] = [];
  let totalPriceCents = 0;
  let totalDepositCents = 0;
  let promoSavingsCents = 0; // USA250 cents removed across all lines (for the ledger)

  // Combo special: the flat combo line (emitted inside buildRaceChargeLines
  // below) IS the whole race+bowl charge, so the bowling item's own line items
  // are suppressed — charging both would double-charge the bowling. Raw $0
  // pass-through items + the booking fee still ride along (not bowling value).
  // The QAMF reservation is still created/confirmed downstream. CheckoutStep
  // suppresses the same lines from the review, so displayed == charged.
  const comboActive = activeComboSpecial(session) != null;

  // Bowling / KBF items
  for (const item of session.items) {
    if (!isBowlingLike(item)) continue;

    // USA250: reduce the price key on priced bowling lines. Catalog-only
    // lines with no local price (fees) carry priceCents 0 → factor 1 → untouched.
    const bowlVisitDate = item.date ?? item.bookedAt?.slice(0, 10) ?? undefined;
    for (const li of comboActive ? [] : item.lineItems) {
      const fullCents = li.priceCents ?? 0;
      const factor =
        fullCents > 0
          ? promoFactor({ domain: "bowling", visitDate: bowlVisitDate }, session.appliedPromo)
          : 1;
      const priceCents = factor === 1 ? fullCents : Math.round(fullCents * factor);
      const depPct = li.depositPct ?? 100;
      const lineTotal = priceCents * li.quantity;
      totalPriceCents += lineTotal;
      totalDepositCents += Math.round(lineTotal * (depPct / 100));
      promoSavingsCents += (fullCents - priceCents) * li.quantity;

      if (li.squareCatalogObjectId && factor === 1) {
        sqLineItems.push({
          name: li.label ?? "Bowling",
          quantity: String(li.quantity),
          catalogObjectId: li.squareCatalogObjectId,
        });
      } else if (li.squareCatalogObjectId) {
        // Discounted catalog line: keep the catalog link for categorization but
        // override the price key with the reduced amount.
        sqLineItems.push({
          name: li.label ?? "Bowling",
          quantity: String(li.quantity),
          catalogObjectId: li.squareCatalogObjectId,
          basePriceMoney: { amount: priceCents, currency: "USD" },
        });
      } else {
        sqLineItems.push({
          name: li.label ?? "Bowling",
          quantity: String(li.quantity),
          basePriceMoney: { amount: priceCents, currency: "USD" },
        });
      }
    }

    // Raw items (pizza/soda $0 passthrough)
    for (const ri of item.rawItems) {
      sqLineItems.push({
        name: ri.name,
        quantity: String(ri.quantity),
        catalogObjectId: ri.catalogObjectId,
        ...(ri.note ? { note: ri.note } : {}),
      });
    }

    // Booking fee
    if (item.hasBookingFee) {
      sqLineItems.push({
        name: "Booking Fee",
        quantity: "1",
        catalogObjectId: BOOKING_FEE_CATALOG_ID,
      });
      totalPriceCents += 299;
      totalDepositCents += 299;
    }
  }

  // Race items — $0 model. Build the SAME charge lines the credit path uses
  // (buildRaceChargeLines: package bundle / combo pack / single + license + POV),
  // so displayed == charged, then map each to a Square line. Credit-redeemed HEATS
  // are excluded (charged $0; one credit deducted each) — capped per racer at their
  // combined eligible balance, so a racer with fewer credits than heats still pays
  // cash for the uncovered heats instead of zeroing the whole order.
  const redeemedHeats = redeemedHeatSet(session);
  for (const bl of buildRaceChargeLines(session, redeemedHeats)) {
    const totalCents = Math.round(bl.amount * 100);
    const unitCents = bl.quantity > 0 ? Math.round(totalCents / bl.quantity) : totalCents;
    const catalogId =
      (bl.bmiProductId ? lookupCatalogId(bl.bmiProductId) : null) ?? lookupCatalogIdByName(bl.name);
    totalPriceCents += totalCents;
    totalDepositCents += totalCents; // 100% deposit for race
    // Race + combo savings (combo lines flow through here too, pre-stamped).
    promoSavingsCents +=
      bl.originalAmount != null ? Math.round((bl.originalAmount - bl.amount) * 100) : 0;

    sqLineItems.push({
      name: bl.name,
      quantity: String(bl.quantity),
      ...(catalogId
        ? { catalogObjectId: catalogId, basePriceMoney: { amount: unitCents, currency: "USD" } }
        : { basePriceMoney: { amount: unitCents, currency: "USD" } }),
    });
  }

  // Attraction items
  for (const item of session.items) {
    if (item.kind !== "attraction") continue;
    const attr = item as AttractionItem;
    if (!attr.productId) continue;

    const catalogId = lookupCatalogId(attr.productId);
    // USA250: reduce the price key on the attraction line when eligible.
    const fullUnitCents = Math.round(attr.price * 100);
    const factor = promoFactor(
      { domain: "attractions", visitDate: attr.date, productSlug: attr.slug },
      session.appliedPromo,
    );
    const unitCents = factor === 1 ? fullUnitCents : Math.round(fullUnitCents * factor);
    const lineTotal = unitCents * attr.qty;
    totalPriceCents += lineTotal;
    totalDepositCents += lineTotal; // 100% deposit for attractions
    promoSavingsCents += (fullUnitCents - unitCents) * attr.qty;

    sqLineItems.push({
      name: attr.slug ?? "Attraction",
      quantity: String(attr.qty),
      ...(catalogId
        ? { catalogObjectId: catalogId, basePriceMoney: { amount: unitCents, currency: "USD" } }
        : { basePriceMoney: { amount: unitCents, currency: "USD" } }),
    });
  }

  const depositPct =
    totalPriceCents > 0 ? Math.round((totalDepositCents / totalPriceCents) * 100) : 100;

  return { sqLineItems, depositPct, promoSavingsCents };
}

// ── Route-entry idempotency guard + lock ──────────────────────────────

/**
 * Rebuild a UnifiedReserveResult for an already-confirmed BMI bill from the
 * `bmi:confirmed` cache + the Neon row — NO Square / BMI calls. confirmBmiPayment
 * is NOT idempotent (a 2nd confirm reverts BMI state), so this short-circuit is
 * what makes a retry / double-submit safe for the race + attraction path.
 * Returns null when the bill hasn't been confirmed yet.
 */
async function unifiedCachedSuccess(bmiBillId: string): Promise<UnifiedReserveResult | null> {
  let cached: unknown;
  try {
    cached = await redis.get(`bmi:confirmed:${bmiBillId}`);
  } catch {
    return null;
  }
  if (!cached) return null;
  let c: { reservationNumber?: string; reservationCode?: string };
  try {
    c = typeof cached === "string" ? JSON.parse(cached) : (cached as typeof c);
  } catch {
    return null;
  }
  const row = await getBowlingReservationByBillId(bmiBillId).catch(() => null);
  return {
    neonIds: row?.id ? [row.id] : [],
    shortCodes: [],
    qamfReservationIds: [],
    bmiReservationNumber: c.reservationNumber ?? row?.bmiReservationNumber ?? null,
    bmiReservationCode: c.reservationCode ?? null,
    squareDayofOrderId: row?.squareDayofOrderId ?? "",
    giftCardGan: row?.squareGiftCardGan ?? null,
    depositCents: row?.depositCents ?? 0,
    totalCents: row?.totalCents ?? 0,
  };
}

export class ReserveInProgressError extends Error {
  code = "RESERVE_IN_PROGRESS";
  constructor() {
    super("A booking for this reservation is already in progress.");
  }
}

/**
 * Thrown when a race bill auto-cancelled in BMI before the customer paid (BMI
 * strips the products off a Pending-Online hold past the center's timeout). We
 * detect it BEFORE charging, so the card is never touched — the customer is
 * told their held time lapsed and to pick again.
 */
export class BillExpiredError extends Error {
  code = "BILL_EXPIRED";
  constructor() {
    super(
      "Your held race time expired before payment, so we didn't charge you. Please go back and choose a time again.",
    );
    this.name = "BillExpiredError";
  }
}

// ── Main orchestrator ─────────────────────────────────────────────────

/**
 * Public entry: idempotency guard (already-confirmed short-circuit + per-session
 * NX lock) wrapped around the charge/confirm fan-out. The lock prevents two
 * concurrent submits from both fanning out (QAMF createReservation has no
 * idempotency key); the deterministic baseKey inside makes Square replay-safe.
 */
export async function unifiedReserve(input: UnifiedReserveInput): Promise<UnifiedReserveResult> {
  const { session } = input;
  const bowlingItems = session.items.filter(isBowlingLike);
  // Stable per-session anchor for the seed + lock. bmiBillId for BMI sessions;
  // the Square session order or QAMF hold id otherwise.
  const seedSource =
    session.bmiBillId ?? session.squareOrderId ?? bowlingItems[0]?.qamfReservationId ?? null;

  // 1) Already confirmed? Return the first call's result (no second charge /
  //    confirm). Only meaningful for BMI sessions (the cache key is the bill).
  if (session.bmiBillId) {
    const cached = await unifiedCachedSuccess(session.bmiBillId).catch(() => null);
    if (cached) return cached;
  }

  // 2) In-flight? NX lock keyed on the session anchor.
  const lockKey = seedSource ? `reserve:lock:${seedSource}` : null;
  let lockHeld = false;
  if (lockKey) {
    try {
      lockHeld = (await redis.set(lockKey, "1", "EX", 120, "NX")) === "OK";
    } catch {
      lockHeld = true; // Redis down — deterministic keys still prevent a double charge
    }
    if (!lockHeld) {
      if (session.bmiBillId) {
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const cached = await unifiedCachedSuccess(session.bmiBillId).catch(() => null);
          if (cached) return cached;
        }
      }
      throw new ReserveInProgressError();
    }
  }

  try {
    return await unifiedReserveInner(input, seedSource);
  } finally {
    if (lockKey && lockHeld) {
      await redis.del(lockKey).catch(() => {});
    }
  }
}

async function unifiedReserveInner(
  input: UnifiedReserveInput,
  seedSource: string | null,
): Promise<UnifiedReserveResult> {
  const { session, contact } = input;
  const locationId = resolveLocationId(session);
  // Deterministic idempotency seed — same session anchor → same Square keys on
  // every retry, so all 7 keys replay the SAME order / payment / gift card.
  const baseKey = seedSource ? reserveBaseKey(seedSource) : randomBytes(8).toString("hex");

  const bowlingItems = session.items.filter(isBowlingLike);
  const raceItems = session.items.filter((i): i is RaceItem => i.kind === "race");
  const attractionItems = session.items.filter((i): i is AttractionItem => i.kind === "attraction");
  const hasBmi = raceItems.length > 0 || attractionItems.length > 0;

  // ── 0. Guard: never charge against an auto-cancelled BMI bill ──────
  // BMI auto-cancels a Pending-Online hold after the center's timeout, stripping
  // the bill's products. If that happened during the customer's dwell, charging
  // here would take money for a reservation that no longer exists (BMI then
  // returns BillNotFound at payment/confirm — AFTER the card is captured, the
  // "charged but empty" failure). Re-check the bill is live BEFORE any Square
  // write. Fail-open on a transient overview error: a BMI hiccup must never block
  // a legitimate paying customer, and the auto-cancel case returns a clean empty
  // overview (caught), not an error.
  if (hasBmi && session.bmiBillId) {
    let live = true;
    try {
      live = await bmiBillIsLive(resolveBmiClientKey(session), session.bmiBillId);
    } catch (err) {
      console.error("[unifiedReserve] bill liveness check errored (failing open):", err);
    }
    if (!live) {
      console.error(
        `[unifiedReserve] BILL_EXPIRED — bmiBillId ${session.bmiBillId} auto-cancelled before payment; refusing to charge`,
      );
      throw new BillExpiredError();
    }
  }

  // ── 1. Extend QAMF holds as safety net ────────────────────────────
  for (const item of bowlingItems) {
    if (item.qamfReservationId && item.qamfCenterId) {
      try {
        await extendReservation(item.qamfCenterId, item.qamfReservationId);
      } catch {
        // Non-fatal — confirm step handles expired holds
      }
    }
  }

  // ── 2. Build combined Square line items ────────────────────────────
  const { sqLineItems, depositPct, promoSavingsCents } = buildCombinedLineItems(session);

  if (sqLineItems.length === 0) {
    throw new Error("No line items to charge");
  }

  // ── 2b. Validate credit redemptions (charge-time re-eval) ─────────
  // Re-check each redeeming racer's LIVE balance before charging. Throws
  // CreditRedemptionError (→ 400 in the route) on a stale/insufficient balance,
  // so we never charge or give a free race on a credit they no longer hold.
  // Combo special: race credits never combine with the flat combo price — the
  // checkout hides the opt-in, and this guard makes sure no stale opt-in can
  // deduct credits the combo line didn't discount for.
  const creditRedemptions =
    activeComboSpecial(session) != null ? [] : redemptionsFromSession(session);
  if (creditRedemptions.length > 0) {
    await validateCreditRedemptions(creditRedemptions);
  }

  // ── 3. Create the Square day-of order(s) ──────────────────────────
  // Default: ONE order at the session's location. COMBO SPLIT: the itemized
  // revenue lines are grouped by entity (FastTrax racing + HeadPinz bowling)
  // into TWO orders at their own locations, each with its own location tax —
  // so revenue books where it belongs. One deposit + one shared gift card
  // fund both (a Square gift card is seller-wide), and each location's
  // settlement (race-dayof-pay / lane-open) charges the card for ITS order's
  // own outstanding total. See tasks/combo-split-orders-plan.md.
  const createDayofOrder = async (
    locId: string,
    items: SquareLineItem[],
    keySuffix: string,
  ): Promise<{ orderId: string; totalCents: number }> => {
    const taxCatalogId = LOCATION_TAX[locId];
    const orderTaxes = taxCatalogId
      ? [{ uid: "location-sales-tax", catalog_object_id: taxCatalogId, scope: "ORDER" }]
      : [];
    const res = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `unified-dayof-${baseKey}-${keySuffix}`,
        order: {
          location_id: locId,
          ...(input.squareCustomerId ? { customer_id: input.squareCustomerId } : {}),
          line_items: items.map((li) => {
            if (li.catalogObjectId) {
              return {
                catalog_object_id: li.catalogObjectId,
                quantity: li.quantity,
                ...(li.basePriceMoney ? { base_price_money: li.basePriceMoney } : {}),
                ...(li.note ? { note: li.note } : {}),
              };
            }
            return {
              name: li.name,
              quantity: li.quantity,
              base_price_money: li.basePriceMoney,
              ...(li.note ? { note: li.note } : {}),
            };
          }),
          ...(orderTaxes.length > 0 ? { taxes: orderTaxes } : {}),
        },
      }),
    });
    const data = await res.json();
    if (!res.ok || data.errors) {
      const sqErr = data.errors?.[0];
      throw new Error(`Square order failed: ${sqErr?.code}: ${sqErr?.detail}`);
    }
    const orderId: string = data.order?.id;
    if (!orderId) throw new Error("Square order returned no ID");
    return { orderId, totalCents: data.order?.total_money?.amount ?? 0 };
  };

  // squareDayofOrderId = the PRIMARY order (race/BMI anchor + the return value).
  // bowlingDayofOrderId = the order the bowling Neon row settles against (its
  // own order in a combo; the same single order otherwise).
  const orderGroups = comboOrderGroups(session);
  let squareDayofOrderId: string;
  let dayofTotalCents: number;
  let bowlingDayofOrderId: string;
  // Per-order tax-inclusive totals, stored on each Neon row so settlement +
  // reporting reflect that order's share (not the combined combo total).
  // Both equal dayofTotalCents for a single order.
  let bowlingOrderTotalCents: number;
  let raceOrderTotalCents: number;
  // Pre-reward total of the ONE order the loyalty reward attaches to
  // (squareDayofOrderId). The reward block below subtracts this order's
  // reduction from the COMBINED total — see the reward fix there.
  let primaryDayofPreRewardCents: number;
  if (orderGroups) {
    const byEntity: Record<string, { orderId: string; totalCents: number }> = {};
    for (const g of orderGroups) {
      const locId =
        g.entity === "fasttrax-fm" ? SQUARE_LOCATIONS.FASTTRAX_FM : SQUARE_LOCATIONS.HEADPINZ_FM;
      const items: SquareLineItem[] = g.lines.map((l) => ({
        name: l.name,
        quantity: String(l.quantity),
        catalogObjectId: l.catalogObjectId,
        basePriceMoney: { amount: l.unitCents, currency: "USD" },
      }));
      byEntity[g.entity] = await createDayofOrder(locId, items, g.entity);
    }
    const ft = byEntity["fasttrax-fm"];
    const hp = byEntity["headpinz-fm"];
    // FastTrax racing order anchors the BMI/race side; HeadPinz order settles
    // via lane-open. If a combo ever has only one entity, both point at it.
    squareDayofOrderId = ft?.orderId ?? hp!.orderId;
    bowlingDayofOrderId = hp?.orderId ?? squareDayofOrderId;
    bowlingOrderTotalCents = hp?.totalCents ?? 0;
    raceOrderTotalCents = ft?.totalCents ?? 0;
    dayofTotalCents = (ft?.totalCents ?? 0) + (hp?.totalCents ?? 0);
    // The reward applies to squareDayofOrderId (ft when present, else hp).
    primaryDayofPreRewardCents = ft?.totalCents ?? hp?.totalCents ?? 0;
  } else {
    const single = await createDayofOrder(locationId, sqLineItems, "single");
    squareDayofOrderId = single.orderId;
    bowlingDayofOrderId = single.orderId;
    bowlingOrderTotalCents = single.totalCents;
    raceOrderTotalCents = single.totalCents;
    dayofTotalCents = single.totalCents;
    primaryDayofPreRewardCents = single.totalCents;
  }

  // ── 4. Loyalty reward ─────────────────────────────────────────────
  let loyaltyRewardId: string | undefined;
  const rewardDiscountCents = input.rewardDiscountCents ?? 0;

  if (input.rewardTierId && input.loyaltyAccountId && SQUARE_TOKEN) {
    try {
      const createRes = await fetch(`${SQUARE_BASE}/loyalty/rewards`, {
        method: "POST",
        headers: sqHeaders(),
        body: JSON.stringify({
          reward: {
            loyalty_account_id: input.loyaltyAccountId,
            reward_tier_id: input.rewardTierId,
            order_id: squareDayofOrderId,
          },
          idempotency_key: `reward-${squareDayofOrderId}-${input.rewardTierId}`,
        }),
      });
      const createData = await createRes.json();
      if (createRes.ok && createData.reward?.id) {
        loyaltyRewardId = createData.reward.id;

        // Re-fetch order total after reward adjustment
        try {
          const orderRes = await fetch(`${SQUARE_BASE}/orders/${squareDayofOrderId}`, {
            headers: sqHeaders(),
          });
          if (orderRes.ok) {
            const orderData = await orderRes.json();
            const adjusted = orderData.order?.total_money?.amount;
            if (typeof adjusted === "number") {
              // The reward discounts ONLY the order it's attached to
              // (squareDayofOrderId), whose pre-reward total is
              // primaryDayofPreRewardCents. Subtract THAT order's reduction from
              // the COMBINED total. The old code overwrote dayofTotalCents with
              // this one order's post-reward total — which, for a combo split
              // (two day-of orders), dropped the OTHER order entirely and
              // undercharged the deposit by the bowling leg's full amount.
              // (Marudas incident, 2026-06-23.)
              const rewardReduction = primaryDayofPreRewardCents - adjusted;
              if (rewardReduction > 0) dayofTotalCents -= rewardReduction;
            }
          }
        } catch {
          // Non-fatal
        }
      } else {
        // Square rejected the reward create — log WHY (scope/points/account
        // mismatch) so the hard-fail below is diagnosable. Mirrors the bowling
        // path's logging.
        const e = createData.errors?.[0];
        console.error(
          `[unified-reserve] Loyalty reward creation failed: ${createRes.status} ${e?.code}: ${e?.detail}`,
        );
      }
    } catch (err) {
      console.error("[unified-reserve] Loyalty reward error:", err);
      if (loyaltyRewardId) {
        await fetch(`${SQUARE_BASE}/loyalty/rewards/${loyaltyRewardId}`, {
          method: "DELETE",
          headers: sqHeaders(),
        }).catch(() => {});
        loyaltyRewardId = undefined;
      }
    }
  }

  if (rewardDiscountCents > 0 && !loyaltyRewardId) {
    throw new RewardFailedError();
  }

  // Note: no separate displayed==charged guard here. The USA250 reduction is
  // computed by the SAME deterministic helper (promo-pricing) on both the display
  // and charge sides, so the discounted price matches by construction — exactly
  // like the per-racer membership discount. A naive total-compare guard is unsafe
  // in this flow: the client "due now" (credits/partial deposit) and the server's
  // full post-reward order total are different quantities and would false-positive.

  // ── 5. Charge ONE deposit ─────────────────────────────────────────
  // CRITICAL (combo split): dayofTotalCents is the SUM of BOTH day-of orders
  // (FastTrax racing + HeadPinz bowling, tax-inclusive). The single deposit is
  // depositPct% of that combined total, so the one shared gift card is loaded
  // with the full amount and each order's settlement can draw its own share.
  const rawDepositCents = Math.round((dayofTotalCents * depositPct) / 100);
  const depositCents = Math.max(0, rawDepositCents - (loyaltyRewardId ? 0 : rewardDiscountCents));

  let depositResult: {
    depositOrderId: string | null;
    depositPaymentId: string | null;
    giftCardId: string | null;
    giftCardGan: string | null;
  } = { depositOrderId: null, depositPaymentId: null, giftCardId: null, giftCardGan: null };

  if (depositCents > 0) {
    if (!input.cardSourceId && !input.giftCardNonce) {
      throw new Error("Card or gift card required for paid orders");
    }

    const ganPrefix = buildGanPrefix("WEB", locationId);
    // Stable GAN suffix from the session anchor (matches reserve's bill.slice(-8))
    // so a retry replays gc-${baseKey} with the SAME requested GAN — one card,
    // never a second.
    const ganSuffix = (
      session.bmiBillId ??
      bowlingItems[0]?.qamfReservationId ??
      seedSource ??
      baseKey
    ).slice(-8);

    try {
      const dr = await createDepositAndCharge({
        amountCents: depositCents,
        locationId,
        cardSourceId: input.cardSourceId,
        giftCardNonce: input.giftCardNonce,
        squareCustomerId: input.squareCustomerId,
        ganPrefix,
        ganSuffix,
        note: `Deposit - ${ganPrefix}${ganSuffix} - ${new Date().toISOString().slice(0, 10)}`,
        baseKey,
        buyerEmail: contact.email,
      });
      depositResult = {
        depositOrderId: dr.depositOrderId,
        depositPaymentId: dr.depositPaymentId,
        giftCardId: dr.giftCardId,
        giftCardGan: dr.giftCardGan,
      };
    } catch (err) {
      // Clean up loyalty reward if deposit fails
      if (loyaltyRewardId) {
        await fetch(`${SQUARE_BASE}/loyalty/rewards/${loyaltyRewardId}`, {
          method: "DELETE",
          headers: sqHeaders(),
        }).catch(() => {});
      }
      throw err;
    }
  }

  // ── Record the USA250 redemption (idempotent, soft-fail) ──────────
  // The deposit is captured + squareDayofOrderId exists, so log the use now —
  // keyed on the order id so a retry never double-counts. A combo's two orders
  // share ONE redemption (the anchor). NEVER fail a captured booking on this.
  if (session.appliedPromo && promoSavingsCents > 0) {
    try {
      const codeRow = await getDiscountCodeByCode(session.appliedPromo.code);
      if (codeRow) {
        await recordRedemption({
          codeId: codeRow.id,
          domain: session.appliedPromo.domains[0] ?? "racing",
          externalRef: squareDayofOrderId,
          amountOffCents: promoSavingsCents,
          squareCustomerId: input.squareCustomerId,
        });
      }
    } catch (err) {
      console.error("[unified-reserve] discount redemption record failed (non-fatal):", err);
    }
  }

  // ── 6. Fan out confirmations ──────────────────────────────────────

  const neonIds: number[] = [];
  const shortCodes: string[] = [];
  const qamfReservationIds: string[] = [];
  let bmiReservationNumber: string | null = null;
  let bmiReservationCode: string | null = null;

  // QAMF confirmations (bowling/kbf)
  const logKey = `unified-reserve:log:${baseKey}`;
  const logEntries: string[] = [];
  const log = (msg: string) => {
    console.log(msg);
    logEntries.push(`${new Date().toISOString()} ${msg}`);
  };

  log(
    `[unified-reserve] bowlingItems=${bowlingItems.length} raceItems=${raceItems.length} attractionItems=${attractionItems.length}`,
  );

  for (const item of bowlingItems) {
    const centerId = item.qamfCenterId ?? 9172;
    const playerCount =
      item.kind === "bowling"
        ? (item as BowlingItem).playerCount
        : (item as KbfItem).bowlers.length + (item as KbfItem).paidAdults;

    const players = Array.from({ length: playerCount }, (_, i) => ({
      name: `Bowler ${i + 1}`,
    }));

    const guest = {
      name: `${contact.firstName} ${contact.lastName}`.trim(),
      phone: contact.phone ?? "",
      email: contact.email ?? "",
    };
    const bookedAt = item.bookedAt ?? new Date().toISOString();
    const webOfferId = item.webOfferId ?? 0;
    const optionId = item.optionId;
    const optionType = item.optionType ?? "Game";
    const service = "BookForLater";

    const qamfOptions: Record<string, Array<{ Id: number }>> = {};
    if (optionId) {
      if (optionType === "Time") qamfOptions.Time = [{ Id: optionId }];
      else if (optionType === "Unlimited") qamfOptions.Unlimited = [{ Id: optionId }];
      else qamfOptions.Game = [{ Id: optionId }];
    }

    log(
      `[unified-reserve] QAMF confirm: centerId=${centerId} holdId=${item.qamfReservationId ?? "NONE"} ` +
        `webOfferId=${webOfferId} optionId=${optionId} bookedAt=${bookedAt} players=${playerCount} ` +
        `guest=${JSON.stringify(guest)}`,
    );

    // ── QAMF confirm — INLINE from v1 bowling reserve (proven working) ──
    let qamfReservationId: string;
    let qamfConfirmed = false;
    let qamfLanes: Array<{ Id?: string; LaneNumber: number }> = [];

    async function attachAndConfirm(resId: string): Promise<boolean> {
      await setReservationCustomer(centerId, resId, {
        Guest: { Name: guest.name, PhoneNumber: guest.phone, Email: guest.email },
      });
      return setReservationStatus(centerId, resId, "Confirmed");
    }

    try {
      if (item.qamfReservationId) {
        qamfReservationId = item.qamfReservationId;
        log(`[unified-reserve] Hold-first path: ${qamfReservationId}`);

        let holdCustomerAttached = false;
        try {
          await Promise.all([
            setReservationCustomer(centerId, qamfReservationId, {
              Guest: { Name: guest.name, PhoneNumber: guest.phone, Email: guest.email },
            }),
            patchReservation(centerId, qamfReservationId, {
              Title: `${guest.name} (${players.length}p)`,
            }).catch(() => {}),
          ]);
          holdCustomerAttached = true;
          log(`[unified-reserve] Customer attached to ${qamfReservationId}`);
        } catch (err) {
          log(
            `[unified-reserve] Customer attach failed: ${err instanceof Error ? err.message : err}`,
          );
        }

        if (holdCustomerAttached) {
          qamfConfirmed = await setReservationStatus(centerId, qamfReservationId, "Confirmed");
          log(`[unified-reserve] Status confirm result: ${qamfConfirmed}`);
          // Rename title AFTER confirm (hold title stays "Hold (Np)" otherwise)
          if (qamfConfirmed) {
            patchReservation(centerId, qamfReservationId, {
              Title: `${guest.name} (${players.length}p)`,
            }).catch(() => {});
          }
        }

        if (!qamfConfirmed) {
          log(`[unified-reserve] Hold confirm failed — creating fresh`);
          const reservation = await createReservation(centerId, {
            BookedAt: bookedAt,
            Title: `${guest.name} (${players.length}p)`,
            Customer: {
              Guest: { Name: guest.name, PhoneNumber: guest.phone, Email: guest.email },
            },
            WebOffer: { Id: webOfferId, Options: qamfOptions, Services: [service] },
            TotalPlayers: players.length,
          });
          qamfReservationId = reservation.Id;
          qamfLanes = reservation.Lanes ?? [];
          log(`[unified-reserve] Fresh reservation: ${qamfReservationId}`);
          qamfConfirmed = await attachAndConfirm(qamfReservationId).catch(() => false);
        }
      } else {
        log(`[unified-reserve] No hold — creating fresh`);
        const reservation = await createReservation(centerId, {
          BookedAt: bookedAt,
          Title: `${guest.name} (${players.length}p)`,
          Customer: {
            Guest: { Name: guest.name, PhoneNumber: guest.phone, Email: guest.email },
          },
          WebOffer: { Id: webOfferId, Options: qamfOptions, Services: [service] },
          TotalPlayers: players.length,
        });
        qamfReservationId = reservation.Id;
        qamfLanes = reservation.Lanes ?? [];
        qamfConfirmed = await attachAndConfirm(qamfReservationId).catch(() => false);
      }

      // Fetch lanes if not captured from createReservation
      if (qamfLanes.length === 0) {
        try {
          const laneRes = await getReservation(centerId, qamfReservationId);
          qamfLanes = laneRes.Lanes ?? [];
        } catch {
          /* non-fatal */
        }
      }

      // Push player names to QAMF
      if (qamfLanes.length > 0) {
        const lane = qamfLanes[0];
        const laneId = lane.Id ?? String(lane.LaneNumber);
        setLanePlayers(
          centerId,
          qamfReservationId,
          laneId,
          players.map((p) => ({ Name: p.name || "Bowler", ActivateBumpers: false })),
        ).catch(() => {});
      }

      log(`[unified-reserve] QAMF done: id=${qamfReservationId} confirmed=${qamfConfirmed}`);
      qamfReservationIds.push(qamfReservationId);

      // Neon reservation for bowling
      const centerCode = session.center ?? "fort-myers";
      const productKind: ReservationProductKind = item.kind === "kbf" ? "kbf" : "open";

      try {
        const reservation = await insertBowlingReservation(
          {
            centerCode,
            productKind,
            qamfReservationId,
            squareDepositOrderId: depositResult.depositOrderId ?? undefined,
            squareDepositPaymentId: depositResult.depositPaymentId ?? undefined,
            // Combo split: the bowling row settles its OWN HeadPinz order via
            // lane-open (the shared gift card funds it). Single carts: the one
            // order. Totals reflect the bowling order's share (100% deposit).
            squareDayofOrderId: bowlingDayofOrderId,
            squareGiftCardId: depositResult.giftCardId ?? undefined,
            squareGiftCardGan: depositResult.giftCardGan ?? undefined,
            depositCents: orderGroups ? bowlingOrderTotalCents : depositCents,
            totalCents: bowlingOrderTotalCents,
            status: qamfConfirmed ? "confirmed" : "confirm_pending",
            bookedAt: item.bookedAt ?? new Date().toISOString(),
            playerCount,
            guestName: `${contact.firstName} ${contact.lastName}`.trim(),
            guestEmail: contact.email ?? "",
            guestPhone: contact.phone ?? "",
            notes: `v2 unified ${item.kind} booking`,
            bookingSource: "web",
            squareCustomerId: input.squareCustomerId ?? undefined,
            squareLoyaltyRewardId: loyaltyRewardId ?? undefined,
            rewardDiscountCents: loyaltyRewardId ? rewardDiscountCents : undefined,
            // Combo (Ultimate VIP): stamp the combo id so the reservations
            // portal can flag + group this VIP bowling leg with its race leg
            // (they share square_dayof_order_id).
            comboSpecialId: session.comboSpecialId ?? undefined,
          },
          item.lineItems.map((li) => ({
            squareProductId: li.squareProductId,
            label: li.label ?? "Bowling",
            quantity: li.quantity,
            unitPriceCents: li.priceCents ?? 0,
          })),
        );
        neonIds.push(reservation.id);

        // Generate short code for confirmation URL (same as v1 bowling reserve)
        try {
          const confirmBase =
            item.kind === "kbf"
              ? "/hp/book/kids-bowl-free/confirmation"
              : "/hp/book/bowling/confirmation";
          const code = await shortenUrl(`${confirmBase}?code=_TMP_`);
          await shortenUrl(`${confirmBase}?code=${code}`, code);
          updateBowlingReservationShortCode(reservation.id, code).catch(() => {});
          shortCodes.push(code);
        } catch {
          // Fall back to reservation.shortCode if shortenUrl fails
          if (reservation.shortCode) shortCodes.push(reservation.shortCode);
        }
      } catch (err) {
        console.error("[unified-reserve] Neon insert (bowling) failed (non-fatal):", err);
      }

      // Combo special (Ultimate VIP): this bowling leg is the combo's VIP lane.
      // Lead the QAMF note with a VIP banner so HeadPinz staff see it's the
      // package, and treat shoes as INCLUDED (owner: VIP includes shoes — the
      // generic slug check below misses VIP hourly experiences).
      const combo = session.comboSpecialId ? getComboSpecial(session.comboSpecialId) : null;

      // Final QAMF title + notes patch (v1 parity — includes shoe status,
      // line items, deposit, short URL, and attraction add-ons). Combo bowling
      // legs get a "VIP Exp." prefix so HeadPinz staff spot the VIP package at a
      // glance in the QAMF reservation list (owner request 2026-06-27).
      const finalTitle = combo
        ? `VIP Exp. ${guest.name} (${players.length}p)`
        : `${guest.name} (${players.length}p)`;
      const shortCode = shortCodes[shortCodes.length - 1];

      const finalParts: string[] = [];

      if (combo) {
        finalParts.push(`*** ${combo.name.toUpperCase()} — VIP LANE (paid online) ***`);
      }

      // Shoe status — staff see it at a glance
      const hasShoeAddOn = item.lineItems.some((li) =>
        (li.label ?? "").toLowerCase().includes("shoe"),
      );
      const shoesIncluded =
        !!combo ||
        item.experienceSlug?.includes("fun-4-all") ||
        item.experienceSlug?.includes("pizza-bowl");
      let shoeLine: string;
      if (combo) {
        shoeLine = "Shoes included (VIP)";
      } else if (hasShoeAddOn) {
        const shoeQty = item.lineItems
          .filter((li) => (li.label ?? "").toLowerCase().includes("shoe"))
          .reduce((s, li) => s + li.quantity, 0);
        shoeLine = `${shoeQty} pair${shoeQty !== 1 ? "s" : ""} shoes paid`;
      } else if (shoesIncluded) {
        shoeLine = "Shoes included";
      } else {
        shoeLine = "SHOES NOT INCLUDED";
      }
      if (shortCode) shoeLine += ` | headpinz.com/s/${shortCode}`;
      finalParts.push(shoeLine);

      // Line items summary
      if (item.lineItems.length > 0) {
        const itemParts = item.lineItems.map((li) => {
          const total = (li.priceCents ?? 0) * li.quantity;
          const totalStr = `$${(total / 100).toFixed(2)}`;
          return li.quantity > 1
            ? `${li.quantity}x ${li.label ?? "Item"} ${totalStr}`
            : `${li.label ?? "Item"} ${totalStr}`;
        });
        finalParts.push(itemParts.join(" + "));
      }

      // Tax-inclusive deposit
      if (depositCents > 0) {
        finalParts.push(`Deposit $${(depositCents / 100).toFixed(2)} paid (incl. tax)`);
      }

      const finalNotes = finalParts.join("\n");
      try {
        await patchReservation(centerId, qamfReservationId, {
          Title: finalTitle,
          Notes: finalNotes,
        });
        log(`[unified-reserve] Final patch OK: title="${finalTitle}"`);
      } catch (err) {
        log(`[unified-reserve] Final patch FAILED: ${err instanceof Error ? err.message : err}`);
      }

      // Combo special: stamp the assigned QAMF lane onto the Redis booking
      // record (keyed by the combo's BMI bill) so the confirmation page can
      // fold it into the single reservation memo it writes (the lane is QAMF
      // data the page never otherwise sees). Best-effort, non-fatal.
      if (session.comboSpecialId && session.bmiBillId && qamfLanes.length > 0) {
        const lane = qamfLanes
          .map((l) => l.LaneNumber)
          .filter((n) => n != null)
          .join(", ");
        // Reorder fallback: the combo ran race → race → bowl (lane AFTER both
        // races) when the lane starts later than every race heat. Stamp it so
        // the confirmation page's reservation memo lists the visit plan in the
        // order it will actually run, not the registry's primary order.
        const comboRaceStartsMs = session.items
          .filter((i): i is RaceItem => i.kind === "race")
          .flatMap((ri) => ri.heats)
          .map((h) => h.heatId)
          .filter((s): s is string => !!s)
          .map((s) => wallClockMs(s));
        const comboBowlMs = item.bookedAt ? wallClockMs(item.bookedAt) : null;
        const comboReorder =
          comboBowlMs != null &&
          comboRaceStartsMs.length > 0 &&
          comboRaceStartsMs.every((m) => m < comboBowlMs);
        if (lane) {
          try {
            const key = `bookingrecord:${session.bmiBillId}`;
            const existing = await redis.get(key);
            if (existing) {
              const rec = typeof existing === "string" ? JSON.parse(existing) : existing;
              await redis.set(
                key,
                JSON.stringify({ ...rec, bowlingLane: lane, comboReorder }),
                "EX",
                60 * 60 * 24 * 90,
              );
            }
          } catch (err) {
            log(`[unified-reserve] booking-record lane stamp failed: ${err}`);
          }
        }
      }
    } catch (err) {
      // QAMF failed after the deposit was CAPTURED. Do NOT roll back — a captured
      // payment can't be voided and the funds back the gift card. The bowling row
      // (written above as confirm_pending when QAMF didn't confirm) is driven
      // forward by the bowling-confirm-retry cron.
      console.error("[unified-reserve] QAMF confirm failed (deposit retained):", err);
      throw err;
    }
  }

  // Persist QAMF logs to Redis for debugging (avoids Vercel log truncation)
  if (logEntries.length > 0) {
    redis.set(logKey, JSON.stringify(logEntries), "EX", 86400).catch(() => {});
  }

  // BMI confirmations (race/attraction)
  if (hasBmi && session.bmiBillId) {
    const clientKey = resolveBmiClientKey(session);
    const bmiBillId = session.bmiBillId;
    // STRICT $0 gate (matches checkout.ts): EVERY race item must legitimately use
    // the $0 model before we confirm the BMI bill as a $0 credit. A real-priced
    // item confirmed at $0 = money leak. Packages/combos now pass this (their
    // heats resolve $0 build pairs); a legacy/add-on item correctly fails it.
    const useZeroModel = raceItems.length > 0 && raceItems.every(raceUsesZeroBmiModel);
    const centerCode = session.center ?? "fort-myers";
    const bookingKind: ReservationProductKind = raceItems.length > 0 ? "race" : "attraction";

    // Build the BMI reservation lines + metadata up front so we can anchor the
    // row BEFORE confirming (the deposit is already CAPTURED at this point).
    const bmiLines = [
      ...raceItems.flatMap((r) =>
        r.heats
          .filter((h) => h.productId)
          .map((h) => {
            const product = getRaceProductById(h.productId!);
            return {
              label: product?.name ?? "Race",
              quantity: 1,
              unitPriceCents: Math.round((product?.price ?? 0) * 100),
            };
          }),
      ),
      ...attractionItems.map((a) => ({
        label: a.slug ?? "Attraction",
        quantity: a.qty,
        unitPriceCents: Math.round(a.price * 100),
      })),
    ];

    const bookingMetadata: Record<string, unknown> = {};
    if (raceItems.length > 0) {
      bookingMetadata.heats = raceItems[0].heats.map((h) => ({
        productId: h.productId,
        track: h.track,
        heatId: h.heatId,
        assignedTo: h.assignedTo,
      }));
      bookingMetadata.racerNames = session.party.map((m) => m.firstName);
    }
    // Persist attraction slot START times so the day-of settle cron can tell when
    // the activity has actually happened (the anchor row's booked_at is the
    // BOOKING time, not the slot time). `slot` is the ISO start of the chosen slot.
    if (attractionItems.length > 0) {
      bookingMetadata.attractions = attractionItems
        .filter((a) => a.slot)
        .map((a) => ({ slug: a.slug, slot: a.slot, qty: a.qty }));
    }

    // ── Durable anchor (confirm_pending) BEFORE BMI confirm ───────────
    // A captured deposit must never be stranded without a record. If confirm
    // fails, this row stays confirm_pending/confirm_failed and the
    // race-confirm-reconcile cron drives it forward (money stays on the gift
    // card — never auto-refunded). Idempotent per (bill, kind).
    let bmiNeonId: number | null = null;
    try {
      const existing = await findReusableReservation(bmiBillId, bookingKind);
      if (existing) {
        bmiNeonId = existing.id;
        await updateBowlingReservationSquareIds(existing.id, {
          squareDepositPaymentId: depositResult.depositPaymentId ?? undefined,
          squareDayofOrderId,
          squareGiftCardId: depositResult.giftCardId ?? undefined,
          squareGiftCardGan: depositResult.giftCardGan ?? undefined,
        });
      } else {
        const anchor = await insertBowlingReservation(
          {
            centerCode,
            productKind: bookingKind,
            bmiBillId,
            squareDepositOrderId: depositResult.depositOrderId ?? undefined,
            squareDepositPaymentId: depositResult.depositPaymentId ?? undefined,
            // Combo split: the race anchor settles its OWN FastTrax order via
            // race-dayof-pay (shared gift card funds it). Totals reflect the
            // racing order's share (100% deposit). squareDayofOrderId is the
            // FastTrax order for a combo, the single order otherwise.
            squareDayofOrderId,
            squareGiftCardId: depositResult.giftCardId ?? undefined,
            squareGiftCardGan: depositResult.giftCardGan ?? undefined,
            depositCents: orderGroups ? raceOrderTotalCents : depositCents,
            totalCents: orderGroups ? raceOrderTotalCents : dayofTotalCents,
            status: "confirm_pending",
            bookedAt: new Date().toISOString(),
            playerCount:
              raceItems.reduce((s, r) => s + r.heats.length, 0) +
              attractionItems.reduce((s, a) => s + a.qty, 0),
            guestName: `${contact.firstName} ${contact.lastName}`.trim(),
            guestEmail: contact.email ?? "",
            guestPhone: contact.phone ?? "",
            notes: `v2 unified ${bookingKind} booking`,
            bookingSource: "web",
            squareCustomerId: input.squareCustomerId ?? undefined,
            squareLoyaltyRewardId: loyaltyRewardId ?? undefined,
            rewardDiscountCents: loyaltyRewardId ? rewardDiscountCents : undefined,
            bookingMetadata,
            // Combo (Ultimate VIP): stamp the combo id on the race/attraction
            // leg too, so it groups with the VIP bowling leg in the portal.
            comboSpecialId: session.comboSpecialId ?? undefined,
          },
          bmiLines,
        );
        bmiNeonId = anchor.id;
      }
      if (bmiNeonId != null) neonIds.push(bmiNeonId);
    } catch (err) {
      // The anchor IS the recovery record; if we can't write it after capturing
      // the deposit, fail BEFORE confirming so the client retries (idempotent).
      console.error("[unified-reserve] BMI anchor write failed:", err);
      throw new Error("Could not persist reservation. Please retry.");
    }

    try {
      const bmiResult = await confirmBmiPayment({
        clientKey,
        bmiBillId,
        amountCents: useZeroModel ? 0 : dayofTotalCents,
        asCredit: useZeroModel,
      });
      bmiReservationNumber = bmiResult.reservationNumber;
      bmiReservationCode = bmiResult.reservationCode;

      // Idempotency cache for /api/booking/confirm — the v2 confirmation page calls
      // that endpoint on load; without this it cache-MISSES and re-runs BMI
      // payment/confirm, and the second confirm reverts the project state back to
      // pending. Pre-writing the same cache entry makes the page's call a no-op.
      // Key/shape/TTL must match app/api/booking/confirm/route.ts.
      if (bmiReservationNumber) {
        try {
          await redis.set(
            `bmi:confirmed:${bmiBillId}`,
            JSON.stringify({
              reservationNumber: bmiReservationNumber,
              reservationCode: bmiReservationCode ?? `r${bmiBillId}`,
              orderId: bmiBillId,
            }),
            "EX",
            86400 * 7,
          );
        } catch {
          // Redis down — non-fatal.
        }
      }

      // BMI_AUTOCANCEL_WORKAROUND (mirror of /api/booking/v2/reserve). BMI's
      // payment/confirm records the payment but does NOT set the project-level
      // confirm flag; an unconfirmed project auto-cancels ~168 min later. Set the
      // project state to -3 (Confirmation) via Pandora so cash/mixed race +
      // attraction bookings confirm immediately instead of relying on the
      // bmi-cancel-sweep cron. projectId = orderId + 1 (last-10-digit math stays
      // under MAX_SAFE_INTEGER; the rest of the id is preserved as raw text).
      try {
        const projectIdNum = (Number(bmiBillId.slice(-10)) + 1).toString();
        const projectId = bmiBillId.slice(0, -projectIdNum.length) + projectIdNum;
        const pandoraKey = process.env.SWAGGER_ADMIN_KEY || "";
        const pandoraLocationId =
          raceItems.length > 0
            ? "LAB52GY480CJF"
            : session.center === "naples"
              ? "PPTR5G2N0QXF7"
              : "TXBSQN0FEKQ11";
        const stateRes = await fetch(
          "https://bma-pandora-api.azurewebsites.net/v2/bmi/reservation/state",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${pandoraKey}`,
            },
            body: JSON.stringify({ locationID: pandoraLocationId, projectId, stateID: "-3" }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        console.log(
          `[unified-reserve] Pandora project ${projectId} state → -3 (Confirmation): ${stateRes.ok ? "OK" : stateRes.status}`,
        );
      } catch (pandoraErr) {
        console.error("[unified-reserve] Pandora state update failed (non-fatal):", pandoraErr);
      }

      // Deduct redeemed race credits (post-confirm). Idempotent per heat; a failed
      // deduct enqueues to the retry sweep. Never throws.
      if (creditRedemptions.length > 0) {
        await deductCreditRedemptions(creditRedemptions, { billId: bmiBillId });
      }

      // Promote the anchor → confirmed. Non-fatal: race-confirm-reconcile
      // promotes it if this fails (re-confirm is a cached no-op via bmi:confirmed).
      if (bmiNeonId != null) {
        try {
          await updateBowlingReservationConfirmed(bmiNeonId, {
            bmiReservationNumber: bmiReservationNumber ?? undefined,
          });
        } catch (err) {
          console.error("[unified-reserve] BMI confirmed-status update failed (non-fatal):", err);
        }
      }
    } catch (err) {
      // Captured deposit stays put (forward recovery, never auto-refund). Mark
      // the anchor confirm_failed; race-confirm-reconcile retries BMI confirm.
      console.error("[unified-reserve] BMI confirm failed (deposit retained):", err);
      if (bmiNeonId != null) {
        await updateBowlingReservationConfirmFailed(
          bmiNeonId,
          err instanceof Error ? err.message : "BMI confirm error",
        );
      }
      throw err;
    }
  }

  // Combo special: staff booking alert (owner 2026-06-11 — eric/curtis/alex/
  // jacob). Fired only after EVERYTHING above succeeded; never throws.
  if (session.comboSpecialId) {
    await notifyComboBooked({
      session,
      contact,
      bmiBillId: session.bmiBillId,
      bmiReservationNumber,
      squareDayofOrderId,
      totalCents: dayofTotalCents,
    });
  }

  return {
    neonIds,
    shortCodes,
    qamfReservationIds,
    bmiReservationNumber,
    bmiReservationCode,
    squareDayofOrderId,
    giftCardGan: depositResult.giftCardGan,
    depositCents,
    totalCents: dayofTotalCents,
  };
}

export class RewardFailedError extends Error {
  code = "REWARD_FAILED";
  constructor() {
    super("Your reward couldn't be applied right now. Please try again.");
  }
}
