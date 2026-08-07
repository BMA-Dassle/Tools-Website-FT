/**
 * Bowling booking service — QAMF hold management + reserve orchestration.
 *
 * Implements the BookingService interface for bowling and kbf item kinds.
 * Unlike race/attraction (BMI-backed), bowling is QAMF-backed: holds are
 * temporary QAMF reservations, and the reserve call goes to
 * /api/bowling/v2/reserve (not /api/booking/v2/reserve).
 */
import type { BookingService, BookingQuote } from "./index";
import type { BowlingItem, KbfItem, BookingSession, GameCardCartPurchase } from "../state/types";
import { centerCodeFor } from "~/config/intercard-centers";
import type { ContactInfo } from "../types";
import type { PaymentSourceKind } from "~/features/card-vault/types";
import type { Dispatch } from "react";
import type { Action } from "../state/machine";
import { buildKbfExtraSquareLineItems, isFridayYmd } from "./kbf-pricing";
import { promoFactor } from "./promo-pricing";
import { formatPersonName } from "~/lib/helpers/name-format";
import { qamfCenterCode, HEADPINZ_FM_CENTER_CODE } from "@/lib/qamf-centers";
import { playNowActive } from "../flags";

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
  // USA250: reduce the price key on priced bowling lines. The bowling-only
  // reserve reuses THIS quoted order, so discounting here covers display AND
  // charge. Catalog-only lines (fees) carry no local price → factor 1 → untouched.
  const visitDate = item.date ?? item.bookedAt?.slice(0, 10) ?? undefined;
  const lines: QuoteLineItem[] = item.lineItems.map((li) => {
    const fullCents = li.priceCents ?? 0;
    const factor =
      fullCents > 0 ? promoFactor({ domain: "bowling", visitDate }, session.appliedPromo) : 1;
    const priceCents = factor === 1 ? fullCents : Math.round(fullCents * factor);
    const out: QuoteLineItem = {
      name: li.label ?? `Item ${li.squareProductId}`,
      quantity: String(li.quantity),
      // ALWAYS send the price as base_price_money — even on a catalog-linked
      // line with no promo. FastTrax duckpin's Square item (SQ.DUCKPIN) is
      // VARIABLY priced, so Square 400s the quote order ("is variably priced
      // and requires a value for base_price_money") when we send only
      // catalogObjectId. Square honors base_price_money as a price-key override
      // on fixed-price catalog items too, so this is safe for HeadPinz — and it
      // matches the reserve day-of order, which already always sends
      // unitPriceCents (route.ts sqLineItems), keeping the quote byte-identical
      // to the charge. A failed quote is invisible on the card path
      // (bowlingReserve silently falls back to server-side order building) but
      // FATAL on the kiosk reader path (bowlingTerminalPrepare hard-requires the
      // pre-created quote order → "Bowling quote missing").
      basePriceMoney: { amount: priceCents, currency: "USD" },
    };
    if (li.squareCatalogObjectId) out.catalogObjectId = li.squareCatalogObjectId;
    return out;
  });

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
  /** PaymentForm source tag (card/wallet/saved/gift_card) — drives the
   *  server's card-vault silent capture. */
  sourceKind?: PaymentSourceKind;
  /** Checkout opt-in: keep the captured card permanently. */
  saveCardConsent?: boolean;
  squareCustomerId?: string;
  loyaltyAccountId?: string;
  loyaltyAction?: "signup" | "existing";
  rewardTierId?: string;
  rewardDiscountCents?: number;
  smsOptIn?: boolean;
  /** KIOSK direct-Terminal: the reader already captured the card against OUR
   *  prepared deposit order (bowlingTerminalPrepare). When set, no card token is
   *  sent and the route finalizes (funds the gift card, never re-charges). */
  externalPayment?: {
    paymentId: string;
    depositOrderId: string;
    amountCents: number;
    seed: string;
  };
}

export interface BowlingReserveResult {
  neonId: number;
  shortCode: string | null;
  qamfReservationId: string;
  squareDayofOrderId: string | null;
  depositCents: number;
  totalCents: number;
  /** KIOSK: charged Game Zone card rows for the confirmation screen to fulfill. */
  gameCards?: {
    mode: "new_card" | "reload";
    groupId: string;
    locationCode: number;
    cards: Array<{
      txnId: string;
      packageId: string;
      accountNumber: string;
      tokens: number;
      bonusTokens: number;
    }>;
  };
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
  // Kiosk rosters (item.players) carry real names/shoe sizes/bumpers collected
  // up front; the reserve route persists them to Neon + QAMF at booking time.
  // Web items have no roster → placeholder names, filled in post-booking.
  const roster = item.players;
  const basePlayers =
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
  const players = basePlayers.map((p, i) => {
    const r = roster?.[i];
    if (!r) return p;
    return {
      ...p,
      // KBF keeps its pass-derived names; open bowling takes the typed name —
      // case-normalized once more here (the kiosk formats on blur, but this is
      // the last stop before QAMF lane monitors + Neon see the roster).
      name: item.kind === "kbf" ? p.name : formatPersonName(r.name) || p.name,
      shoeSize: r.shoeSize || null, // "" = own shoes → no rental size recorded
      bumpers: r.bumpers ?? null,
    };
  });

  const kind = item.kind === "kbf" ? "kbf" : item.variant === "hourly" ? "hourly" : "open";
  // Map the QAMF center id to its Square location (9172→FM, 3148→Naples,
  // 11542→FastTrax). Must NOT default a non-FM center to Naples.
  const locationId = qamfCenterCode(centerId) ?? HEADPINZ_FM_CENTER_CODE;

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
      // USA250-style price-key promo: send only the CODE — the route
      // re-validates against Neon and re-derives the reduction itself, so the
      // fallback path (quote failed → no dayofOrderId) charges the discounted
      // price too, and the redemption is recorded on both paths.
      ...(session.appliedPromo ? { promoCode: session.appliedPromo.code } : {}),
      // Kiosk sessions stamp their source so the admin board can badge them.
      ...(session.context?.kiosk ? { bookingSource: "kiosk" } : {}),
      // Play Now ("bowl now" per-lane QR): the route suppresses the booking +
      // lane-ready notifications and turns the lane on server-side at payment.
      ...(playNowActive(session) ? { playNow: true } : {}),
      // KIOSK: Game Zone cards riding this cart — the reserve route re-resolves
      // the exact deposit-order lines prepare created and marks the ledger rows
      // charged (owner 2026-07-18). Same session on prepare + finalize.
      ...(session.context?.kiosk && session.gameCardPurchase
        ? {
            gameCardPurchase: session.gameCardPurchase,
            gameCardLocationCode: centerCodeFor(session.center ?? "fort-myers", session.entryBrand),
          }
        : {}),
      // World Cup match-mode bookings: the slug lets the route run the
      // fixture/center validation + staff title/banner (bowling-only carts
      // reserve through this route, not unified-reserve).
      ...(item.experienceSlug ? { experienceSlug: item.experienceSlug } : {}),
      // Booked-pricing stamp inputs — the route derives pricingMode from
      // kind/slug and persists booking_metadata.bowling for the edit repricer.
      bookingMeta: { laneCount: item.laneCount, durationMultiplier: item.durationMultiplier },
      rawItems: item.rawItems.length > 0 ? item.rawItems : undefined,
      squareToken: params.cardToken,
      giftCardNonce: params.giftCardNonce ?? undefined,
      // Kiosk direct-Terminal: the reader already paid — finalize, don't charge.
      ...(params.externalPayment ? { externalPayment: params.externalPayment } : {}),
      sourceKind: params.sourceKind,
      saveCardConsent: params.saveCardConsent,
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
    // KIOSK: charged Game Zone card rows — the confirmation screen fulfills them.
    ...(data.gameCards ? { gameCards: data.gameCards } : {}),
  };
}

/**
 * KIOSK direct-Terminal PREPARE for a bowling/KBF-only cart. Creates the
 * GIFT_CARD deposit order the paired reader will charge (server-side, no QAMF/Neon
 * yet) and returns its id + amount + the shared `seed`. The reader charges that
 * exact order; then `bowlingReserve({ externalPayment })` finalizes it (funds the
 * gift card, never re-charges). The deposit is the SAME amount bowlingReserve would
 * charge — item.quoteDepositCents minus any reward — so displayed == charged.
 */
export async function bowlingTerminalPrepare(params: {
  item: BowlingLikeItem;
  /** Idempotency seed shared by prepare → finalize. Generated if omitted. */
  seed?: string;
  rewardDiscountCents?: number;
  /**
   * KIOSK: the Square location the deposit order must be created at — the
   * KIOSK'S OWN location, because the paired reader can only charge orders at
   * its device's location (a FastTrax kiosk selling a HeadPinz lane died with
   * "device's location must match the order's location"). Omitted (web) = the
   * bowling center's own location, unchanged.
   */
  depositLocationId?: string;
  /** KIOSK: Game Zone cards riding this cart — lines join the deposit order. */
  gameCardPurchase?: GameCardCartPurchase;
  gameCardLocationCode?: number;
}): Promise<{
  seed: string;
  depositOrderId: string;
  depositCents: number;
  /** The session secret the gift-card routes require (mirrors the unified
   *  rail's prepare). */
  splitToken?: string;
  /** Server says the ambient gift-card rail is live — the gate renders the
   *  ambient pay screen. */
  ambient?: boolean;
}> {
  const { item } = params;
  const seed = params.seed ?? crypto.randomUUID();
  const centerId = item.qamfCenterId;
  if (!centerId) throw new Error("No QAMF center on bowling item");
  const locationId =
    params.depositLocationId ?? qamfCenterCode(centerId) ?? HEADPINZ_FM_CENTER_CODE;
  // The kiosk always quotes before checkout; without it we can't fix the amount
  // the reader charges, so refuse to arm rather than guess.
  if (item.quoteDepositCents == null || item.quoteDayofOrderId == null) {
    throw new Error("Bowling quote missing — cannot start the reader payment");
  }
  const depositCents = Math.max(0, item.quoteDepositCents - (params.rewardDiscountCents ?? 0));
  if (!(depositCents > 0)) throw new Error("Nothing to charge on the reader");

  const res = await fetch("/api/bowling/v2/reserve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prepareOnly: true,
      terminalSeed: seed,
      centerId,
      locationId,
      depositCents,
      // Game Zone cards riding the cart → lines on the deposit order.
      ...(params.gameCardPurchase
        ? {
            gameCardPurchase: params.gameCardPurchase,
            gameCardLocationCode: params.gameCardLocationCode,
          }
        : {}),
      // Enough to satisfy the body shape; the prepare branch returns before the
      // full-booking required-fields gate reads these.
      webOfferId: item.webOfferId,
      bookedAt: item.bookedAt,
      players: [],
      guest: { name: "", email: "", phone: "" },
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.depositOrderId || !(data.depositCents > 0)) {
    throw new Error(data.error || "Couldn't start the reader payment");
  }
  return {
    seed: data.seed ?? seed,
    depositOrderId: data.depositOrderId,
    depositCents: data.depositCents ?? depositCents,
    ...(data.splitToken ? { splitToken: data.splitToken } : {}),
    ...(data.ambient ? { ambient: true } : {}),
  };
}
