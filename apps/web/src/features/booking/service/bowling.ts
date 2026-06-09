/**
 * Bowling booking service — QAMF hold management + reserve orchestration.
 *
 * Implements the BookingService interface for bowling and kbf item kinds.
 * Unlike race/attraction (BMI-backed), bowling is QAMF-backed: holds are
 * temporary QAMF reservations, and the reserve call goes to
 * /api/bowling/v2/reserve (not /api/booking/v2/reserve).
 */
import type { BookingService, BookingQuote } from "./index";
import type { BowlingItem, KbfItem, BookingSession } from "../state/types";
import type { ContactInfo } from "../types";
import type { Dispatch } from "react";
import type { Action } from "../state/machine";
import { buildKbfExtraSquareLineItems, isFridayYmd } from "./kbf-pricing";

type BowlingLikeItem = BowlingItem | KbfItem;

const BOOKING_FEE_CATALOG_ID = "7VKAFU3HDPRSKY7ZB6CKXTRW";

/** A Square order line item in the shape the /quote endpoint accepts. */
export interface QuoteLineItem {
  name: string;
  quantity: string;
  catalogObjectId?: string;
  basePriceMoney?: { amount: number; currency: "USD" };
}

/**
 * Build the Square line items for a bowling/KBF item — products + KBF extras
 * (VIP lane upcharge, adult game fees) + booking fee — matching what the
 * reserve route builds, so POST /api/square/bowling-orders/quote returns the
 * exact tax-inclusive total the customer will be charged.
 */
export function buildBowlingQuoteLineItems(
  item: BowlingLikeItem,
  session: BookingSession,
): QuoteLineItem[] {
  const lines: QuoteLineItem[] = item.lineItems.map((li) => ({
    name: li.label ?? `Item ${li.squareProductId}`,
    quantity: String(li.quantity),
    ...(li.squareCatalogObjectId
      ? { catalogObjectId: li.squareCatalogObjectId }
      : { basePriceMoney: { amount: li.priceCents ?? 0, currency: "USD" as const } }),
  }));

  if (item.kind === "kbf") {
    const roster = session.kbfIdentity?.members ?? [];
    const free = item.bowlers
      .map((id) => roster.find((m) => m.id === id))
      .filter((m): m is NonNullable<typeof m> => Boolean(m));
    const kbfKidCount = free.filter((m) => m.relation === "kid").length;
    const ymd = item.date ?? item.bookedAt?.slice(0, 10) ?? "";
    lines.push(
      ...buildKbfExtraSquareLineItems({
        isVip: item.tier === "vip",
        isFriday: ymd ? isFridayYmd(ymd) : false,
        kbfKidCount,
        fbfAdultCount: free.length - kbfKidCount,
        paidAdultCount: item.paidAdults,
      }),
    );
  }

  if (item.hasBookingFee) {
    lines.push({ name: "Booking Fee", quantity: "1", catalogObjectId: BOOKING_FEE_CATALOG_ID });
  }

  return lines;
}

interface HoldInput {
  session: BookingSession;
  item: BowlingLikeItem;
  dispatch: Dispatch<Action>;
}

// ── Hold: create or reuse QAMF temporary reservation ─────────────────

async function bowlingHold(input: unknown): Promise<{ holdId: string; squareOrderId: string }> {
  const { item } = input as HoldInput;
  if (item.qamfReservationId) {
    return { holdId: item.qamfReservationId, squareOrderId: "" };
  }
  return { holdId: "", squareOrderId: "" };
}

// ── Quote: get tax-inclusive total + deposit from Square ──────────────

async function bowlingQuote(_input: unknown): Promise<BookingQuote> {
  throw new Error("bowling.quote() — use POST /api/square/bowling-orders/quote directly");
}

// ── Confirm: no-op (QAMF confirmation happens inside reserve route) ──

async function bowlingConfirm(_input: { holdId: string; contact: ContactInfo }) {
  return { ok: true as const };
}

// ── Cancel: release QAMF hold ────────────────────────────────────────

async function bowlingCancel(input: { holdId: string; reason?: string }) {
  if (!input.holdId) return { ok: true as const };
  try {
    await fetch(`/api/bowling/v2/reserve/hold/${encodeURIComponent(input.holdId)}`, {
      method: "DELETE",
    });
  } catch {
    // Non-fatal — hold may have already expired
  }
  return { ok: true as const };
}

export const bowlingService: BookingService = {
  quote: bowlingQuote,
  hold: bowlingHold,
  confirm: bowlingConfirm,
  cancel: bowlingCancel,
};

// ── Reserve: finalize bowling booking (QAMF + Square + Neon) ─────────

export interface BowlingReserveParams {
  session: BookingSession;
  item: BowlingLikeItem;
  contact: ContactInfo;
  cardToken?: string;
  giftCardNonce?: string;
  squareCustomerId?: string;
  loyaltyAccountId?: string;
  loyaltyAction?: "signup" | "existing";
  rewardTierId?: string;
  rewardDiscountCents?: number;
  smsOptIn?: boolean;
}

export interface BowlingReserveResult {
  neonId: number;
  shortCode: string | null;
  qamfReservationId: string;
  squareDayofOrderId: string | null;
  depositCents: number;
  totalCents: number;
}

export async function bowlingReserve(params: BowlingReserveParams): Promise<BowlingReserveResult> {
  const { session, item, contact } = params;

  const centerId = item.qamfCenterId;
  if (!centerId) throw new Error("No QAMF center on bowling item");

  const playerCount =
    item.kind === "bowling" ? item.playerCount : item.bowlers.length + item.paidAdults;

  // KBF players must carry per-bowler detail so the reserve route can:
  //   - charge paid-adult game fees (isPaidAdult),
  //   - split the VIP upcharge into KBF-kid vs FBF-adult lines (kbfRelation),
  //   - enforce the per-day free-games cap + save shoe prefs (kbfPassId/slot).
  // The roster lives in session.kbfIdentity.members; item.bowlers holds the
  // selected free-bowler ids; item.paidAdults is the guest-adult count.
  const players =
    item.kind === "kbf"
      ? [
          ...item.bowlers.map((id, i) => {
            const m = session.kbfIdentity?.members.find((mm) => mm.id === id);
            const name = m ? `${m.firstName} ${m.lastName}`.trim() : "";
            return {
              name: name || `Bowler ${i + 1}`,
              kbfPassId: m?.passId ?? null,
              kbfMemberSlot: m?.slot ?? null,
              kbfRelation: m?.relation ?? null,
              isPaidAdult: false,
            };
          }),
          ...Array.from({ length: item.paidAdults }, (_, i) => ({
            name: `Adult ${i + 1}`,
            isPaidAdult: true,
          })),
        ]
      : Array.from({ length: playerCount }, (_, i) => ({ name: `Bowler ${i + 1}` }));

  const kind = item.kind === "kbf" ? "kbf" : item.variant === "hourly" ? "hourly" : "open";
  const locationId = centerId === 9172 ? "TXBSQN0FEKQ11" : "PPTR5G2N0QXF7";

  const res = await fetch("/api/bowling/v2/reserve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      centerId,
      kind,
      webOfferId: item.webOfferId,
      optionId: item.optionId ?? undefined,
      optionType: item.optionType ?? undefined,
      bookedAt: item.bookedAt,
      service: "BookForLater",
      players,
      guest: {
        name: `${contact.firstName} ${contact.lastName}`,
        email: contact.email,
        phone: contact.phone,
      },
      lineItems: item.lineItems,
      rawItems: item.rawItems.length > 0 ? item.rawItems : undefined,
      squareToken: params.cardToken,
      giftCardNonce: params.giftCardNonce ?? undefined,
      locationId,
      smsOptIn: params.smsOptIn ?? contact.smsOptIn ?? true,
      squareCustomerId: params.squareCustomerId,
      loyaltyAccountId: params.loyaltyAccountId,
      loyaltyAction: params.loyaltyAction,
      ...(params.rewardTierId
        ? {
            rewardTierId: params.rewardTierId,
            rewardDiscountCents: params.rewardDiscountCents,
          }
        : {}),
      ...(item.qamfReservationId ? { qamfReservationId: item.qamfReservationId } : {}),
      ...(item.quoteDayofOrderId
        ? {
            dayofOrderId: item.quoteDayofOrderId,
            dayofTotalCents: item.quoteTotalCents,
            depositCents: Math.max(0, item.quoteDepositCents - (params.rewardDiscountCents ?? 0)),
          }
        : {}),
      ...(item.hasBookingFee ? { bookingFee: true } : {}),
      ...(item.kind === "bowling" && item.discountCode && item.date
        ? { discountCode: item.discountCode, bookingDate: item.date }
        : {}),
      ...(item.attractionAddons.length > 0
        ? {
            attractionBookings: item.attractionAddons.map((a) => ({
              slug: a.slug,
              name: a.name,
              bmiOrderId: a.bmiOrderId,
              bmiBillLineId: a.bmiBillLineId,
              squareCatalogObjectId: a.squareCatalogObjectId,
              quantity: a.quantity,
              totalPriceDollars: a.totalPrice,
              timeSlot: a.timeSlot,
              timeLabel: a.timeLabel,
            })),
          }
        : {}),
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    // Append the server's diagnostic `reason` (e.g. a Square reward rejection)
    // so the checkout error screen shows WHY, not just the generic message.
    const base = data.error ?? "Bowling reservation failed";
    throw new Error(data.reason ? `${base} (${data.reason})` : base);
  }

  return {
    neonId: data.neonId,
    shortCode: data.shortCode ?? null,
    qamfReservationId: data.qamfReservationId ?? item.qamfReservationId ?? "",
    squareDayofOrderId: data.squareDayofOrderId ?? null,
    depositCents: data.depositCents ?? 0,
    totalCents: data.totalCents ?? 0,
  };
}
