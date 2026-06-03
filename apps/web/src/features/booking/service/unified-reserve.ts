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
import { createDepositAndCharge, rollbackDeposit, DepositPaymentError } from "./deposit";
import { confirmQamfReservation, extendReservation } from "./qamf-confirm";
import { confirmBmiPayment } from "./bmi-confirm";
import {
  lookupCatalogId,
  lookupCatalogIdByName,
  LOCATION_TAX,
  SQUARE_LOCATIONS,
} from "../data/square-catalog-map";
import { getRaceProductById } from "./race-products";
import { LICENSE_PRICE } from "./race-pricing";
import { insertBowlingReservation, type ReservationProductKind } from "@/lib/bowling-db";
import type {
  BookingSession,
  BowlingItem,
  KbfItem,
  RaceItem,
  AttractionItem,
} from "../state/types";
import type { ContactInfo } from "../types";

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

function resolveLocationId(session: BookingSession): string {
  const hasBowling = session.items.some(isBowlingLike);
  if (hasBowling) {
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
} {
  const sqLineItems: SquareLineItem[] = [];
  let totalPriceCents = 0;
  let totalDepositCents = 0;

  // Bowling / KBF items
  for (const item of session.items) {
    if (!isBowlingLike(item)) continue;

    for (const li of item.lineItems) {
      const priceCents = li.priceCents ?? 0;
      const depPct = li.depositPct ?? 100;
      const lineTotal = priceCents * li.quantity;
      totalPriceCents += lineTotal;
      totalDepositCents += Math.round(lineTotal * (depPct / 100));

      if (li.squareCatalogObjectId) {
        sqLineItems.push({
          name: li.label ?? "Bowling",
          quantity: String(li.quantity),
          catalogObjectId: li.squareCatalogObjectId,
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

  // Race items
  for (const item of session.items) {
    if (item.kind !== "race") continue;
    const raceItem = item as RaceItem;

    const grouped = new Map<
      string,
      { name: string; unit: number; qty: number; productId: string }
    >();
    for (const heat of raceItem.heats) {
      if (!heat.productId) continue;
      const product = getRaceProductById(heat.productId);
      if (!product) continue;
      const existing = grouped.get(heat.productId);
      if (existing) existing.qty += 1;
      else
        grouped.set(heat.productId, {
          name: product.name,
          unit: product.price,
          qty: 1,
          productId: heat.productId,
        });
    }

    for (const [, line] of grouped) {
      const catalogId = lookupCatalogId(line.productId) ?? lookupCatalogIdByName(line.name);
      const unitCents = Math.round(line.unit * 100);
      totalPriceCents += unitCents * line.qty;
      totalDepositCents += unitCents * line.qty; // 100% deposit for racing

      sqLineItems.push({
        name: line.name,
        quantity: String(line.qty),
        ...(catalogId
          ? { catalogObjectId: catalogId, basePriceMoney: { amount: unitCents, currency: "USD" } }
          : { basePriceMoney: { amount: unitCents, currency: "USD" } }),
      });
    }

    // License fee for new racers
    const newRacerCount = session.party.filter((m) => m.isNewRacer).length;
    if (newRacerCount > 0) {
      const licenseCents = Math.round(LICENSE_PRICE * 100);
      const licenseCatalog = lookupCatalogIdByName("FastTrax License");
      totalPriceCents += licenseCents * newRacerCount;
      totalDepositCents += licenseCents * newRacerCount;

      sqLineItems.push({
        name: "FastTrax License",
        quantity: String(newRacerCount),
        ...(licenseCatalog
          ? {
              catalogObjectId: licenseCatalog,
              basePriceMoney: { amount: licenseCents, currency: "USD" },
            }
          : { basePriceMoney: { amount: licenseCents, currency: "USD" } }),
      });
    }
  }

  // Attraction items
  for (const item of session.items) {
    if (item.kind !== "attraction") continue;
    const attr = item as AttractionItem;
    if (!attr.productId) continue;

    const catalogId = lookupCatalogId(attr.productId);
    const unitCents = Math.round(attr.price * 100);
    const lineTotal = unitCents * attr.qty;
    totalPriceCents += lineTotal;
    totalDepositCents += lineTotal; // 100% deposit for attractions

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

  return { sqLineItems, depositPct };
}

// ── Main orchestrator ─────────────────────────────────────────────────

export async function unifiedReserve(input: UnifiedReserveInput): Promise<UnifiedReserveResult> {
  const { session, contact } = input;
  const locationId = resolveLocationId(session);
  const baseKey = randomBytes(8).toString("hex");

  const bowlingItems = session.items.filter(isBowlingLike);
  const raceItems = session.items.filter((i): i is RaceItem => i.kind === "race");
  const attractionItems = session.items.filter((i): i is AttractionItem => i.kind === "attraction");
  const hasBmi = raceItems.length > 0 || attractionItems.length > 0;

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
  const { sqLineItems, depositPct } = buildCombinedLineItems(session);

  if (sqLineItems.length === 0) {
    throw new Error("No line items to charge");
  }

  // ── 3. Create ONE Square day-of order ─────────────────────────────
  const taxCatalogId = LOCATION_TAX[locationId];
  const orderTaxes = taxCatalogId
    ? [{ uid: "location-sales-tax", catalog_object_id: taxCatalogId, scope: "ORDER" }]
    : [];

  const dayofOrderRes = await fetch(`${SQUARE_BASE}/orders`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `unified-dayof-${baseKey}`,
      order: {
        location_id: locationId,
        ...(input.squareCustomerId ? { customer_id: input.squareCustomerId } : {}),
        line_items: sqLineItems.map((li) => {
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

  const dayofData = await dayofOrderRes.json();
  if (!dayofOrderRes.ok || dayofData.errors) {
    const sqErr = dayofData.errors?.[0];
    throw new Error(`Square order failed: ${sqErr?.code}: ${sqErr?.detail}`);
  }

  const squareDayofOrderId: string = dayofData.order?.id;
  if (!squareDayofOrderId) throw new Error("Square order returned no ID");
  let dayofTotalCents: number = dayofData.order?.total_money?.amount ?? 0;

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
            if (typeof adjusted === "number") dayofTotalCents = adjusted;
          }
        } catch {
          // Non-fatal
        }
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

  // ── 5. Charge ONE deposit ─────────────────────────────────────────
  const rawDepositCents = loyaltyRewardId
    ? Math.round((dayofTotalCents * depositPct) / 100)
    : Math.round((dayofTotalCents * depositPct) / 100);
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

    const ganPrefix = bowlingItems.length > 0 ? "HPFM" : raceItems.length > 0 ? "RACE" : "ATTR";
    const ganSuffix = baseKey.slice(0, 8);

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

  // ── 6. Fan out confirmations ──────────────────────────────────────

  const neonIds: number[] = [];
  const shortCodes: string[] = [];
  const qamfReservationIds: string[] = [];
  let bmiReservationNumber: string | null = null;
  let bmiReservationCode: string | null = null;

  // QAMF confirmations (bowling/kbf)
  for (const item of bowlingItems) {
    const centerId = item.qamfCenterId ?? 9172;
    const playerCount =
      item.kind === "bowling"
        ? (item as BowlingItem).playerCount
        : (item as KbfItem).bowlers.length + (item as KbfItem).paidAdults;

    const players = Array.from({ length: playerCount }, (_, i) => ({
      name: `Bowler ${i + 1}`,
    }));

    try {
      const qamfResult = await confirmQamfReservation({
        centerId,
        qamfReservationId: item.qamfReservationId ?? undefined,
        bookedAt: item.bookedAt ?? new Date().toISOString(),
        webOfferId: item.webOfferId ?? 0,
        optionId: item.optionId ?? undefined,
        optionType: item.optionType ?? undefined,
        guest: {
          name: `${contact.firstName} ${contact.lastName}`.trim(),
          phone: contact.phone ?? "",
          email: contact.email ?? "",
        },
        players,
      });

      qamfReservationIds.push(qamfResult.qamfReservationId);

      // Neon reservation for bowling
      const centerCode = session.center ?? "fort-myers";
      const productKind: ReservationProductKind = item.kind === "kbf" ? "kbf" : "open";

      try {
        const reservation = await insertBowlingReservation(
          {
            centerCode,
            productKind,
            qamfReservationId: qamfResult.qamfReservationId,
            squareDepositOrderId: depositResult.depositOrderId ?? undefined,
            squareDepositPaymentId: depositResult.depositPaymentId ?? undefined,
            squareDayofOrderId,
            squareGiftCardId: depositResult.giftCardId ?? undefined,
            squareGiftCardGan: depositResult.giftCardGan ?? undefined,
            depositCents,
            totalCents: dayofTotalCents,
            status: qamfResult.confirmed ? "confirmed" : "confirm_pending",
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
          },
          item.lineItems.map((li) => ({
            squareProductId: li.squareProductId,
            label: li.label ?? "Bowling",
            quantity: li.quantity,
            unitPriceCents: li.priceCents ?? 0,
          })),
        );
        neonIds.push(reservation.id);
        if (reservation.shortCode) shortCodes.push(reservation.shortCode);
      } catch (err) {
        console.error("[unified-reserve] Neon insert (bowling) failed (non-fatal):", err);
      }
    } catch (err) {
      // QAMF failed after deposit — rollback deposit
      if (depositResult.depositOrderId) {
        await rollbackDeposit(depositResult.depositOrderId, {
          card: depositResult.depositPaymentId ?? undefined,
        });
      }
      throw err;
    }
  }

  // BMI confirmations (race/attraction)
  if (hasBmi && session.bmiBillId) {
    const clientKey = resolveBmiClientKey(session);
    const useZeroModel = raceItems.length > 0;

    try {
      const bmiResult = await confirmBmiPayment({
        clientKey,
        bmiBillId: session.bmiBillId,
        amountCents: useZeroModel ? 0 : dayofTotalCents,
        asCredit: useZeroModel,
      });
      bmiReservationNumber = bmiResult.reservationNumber;
      bmiReservationCode = bmiResult.reservationCode;

      // Neon reservation for BMI items
      const centerCode = session.center ?? "fort-myers";
      const bookingKind: ReservationProductKind = raceItems.length > 0 ? "race" : "attraction";

      try {
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

        const reservation = await insertBowlingReservation(
          {
            centerCode,
            productKind: bookingKind,
            bmiBillId: session.bmiBillId,
            bmiReservationNumber: bmiReservationNumber ?? undefined,
            squareDepositOrderId: depositResult.depositOrderId ?? undefined,
            squareDepositPaymentId: depositResult.depositPaymentId ?? undefined,
            squareDayofOrderId,
            squareGiftCardId: depositResult.giftCardId ?? undefined,
            squareGiftCardGan: depositResult.giftCardGan ?? undefined,
            depositCents,
            totalCents: dayofTotalCents,
            status: "confirmed",
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
          },
          bmiLines,
        );
        neonIds.push(reservation.id);
      } catch (err) {
        console.error("[unified-reserve] Neon insert (BMI) failed (non-fatal):", err);
      }
    } catch (err) {
      // BMI failed after deposit — rollback
      if (depositResult.depositOrderId) {
        await rollbackDeposit(depositResult.depositOrderId, {
          card: depositResult.depositPaymentId ?? undefined,
        });
      }
      throw err;
    }
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
