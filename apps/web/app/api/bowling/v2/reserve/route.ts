import { NextRequest, NextResponse } from "next/server";
import { randomBytes, randomUUID } from "crypto";
import { buildGanPrefix } from "@/lib/gan";
import { kioskGzCartEnabled } from "~/features/kiosk/flags";
import { resolveCartPurchase } from "~/features/game-cards/cart-purchase";
import { startTxn, markCharged, markLoadState } from "~/features/game-cards/data/transactions-log";
import {
  createReservation,
  getReservation,
  setReservationStatus,
  setReservationCustomer,
  patchReservation,
} from "@/lib/qamf-bowling";
import {
  getBowlingExperienceByOffer,
  getBowlingSquareProduct,
  getKbfRedeemedMembers,
  insertBowlingReservation,
  insertReservationPlayers,
  setBowlingReservationPromo,
  updateBowlingReservationNotes,
  updateBowlingReservationShortCode,
  markLaneReadySent,
  type BowlingSquareProduct,
  type ReservationLine,
} from "@/lib/bowling-db";
import { setLanePlayers } from "@/lib/qamf-bowling";
import { syncShoeKdsLineItems } from "@/lib/bowling-shoe-kds";
import { toLaneInsertName } from "@/lib/qamf-name";
import {
  FASTTRAX_QAMF_CENTER_ID,
  FASTTRAX_CENTER_CODE,
  FASTTRAX_TAX_CATALOG_ID,
  isFastTraxDuckpinCenter,
} from "@/lib/qamf-centers";
import redis from "@/lib/redis";
import {
  stampTerminalPaymentOnAnchor,
  upsertTerminalAnchor,
} from "~/features/booking/service/unified-reserve";
import { kioskAmbientCheckoutEnabled } from "~/features/kiosk/flags";
import { shortenUrl } from "@/lib/short-url";
import {
  normalizePhoneE164,
  recordOptIn,
  resolveAudienceMember,
  splitGuestName,
} from "~/features/marketing";
import { evaluateCode, getDiscountCodeByCode, recordRedemption } from "~/features/discount-codes";
import {
  isWorldCupSlug,
  validateWorldCupBooking,
  WorldCupReservationError,
  worldCupQamfTitle,
  worldCupQamfBanner,
  fixtureLabel,
  type WorldCupFixture,
} from "~/features/world-cup";
import { enrichFixture } from "~/features/world-cup/live-teams";
import { notifyWorldCupBooked } from "~/features/world-cup/notify.server";
import {
  createDepositAndCharge,
  createDepositOrder,
  finalizeDepositFromExternalPayment,
  DepositPaymentError,
  TerminalPaymentUnverifiedError,
  TerminalAmountMismatchError,
} from "~/features/booking/service/deposit";
import { captureCardFromDeposit, type PaymentSourceKind } from "~/features/card-vault";
import { bowlingPricingMode } from "~/features/booking/service/bowling-booked-pricing";
import {
  isMidnightMadnessSlug,
  midnightMadnessWindowError,
  MM_CATALOG_OBJECT_IDS,
} from "~/features/booking/service/bowling-offer";
import { assertBookable, DurationGuardError } from "~/features/booking/service/duration-guard";
import {
  KBF_GAMES_PER_SESSION,
  KBF_VIP_PER_GAME_CENTS,
  kbfAdultPerGameCents,
  buildKbfExtraSquareLineItems,
} from "~/features/booking/service/kbf-pricing";

const CONFIRM_RETRY_QUEUE = "qamf:bowling:confirm-retry";

/** Kiosk direct-Terminal anchor — SHARED namespace with the racing rail
 *  (`kiosk:terminal:anchor:${seed}`) so a single terminal-orphan reconcile can
 *  recover both. Best-effort: Square holds the durable order/payment; this is
 *  only the fast pointer (reconcile can also recover via the order's reference_id). */
/** KIOSK Game Zone cards riding a terminal deposit order — ledger row pointers
 *  persisted at PREPARE so finalize marks them charged (see unified rail). */
type AnchorGameCards = {
  mode: "new_card" | "reload";
  groupId: string;
  locationCode: number;
  totalCents: number;
  cards: Array<{ txnId: string; packageId: string; accountNumber: string }>;
};

/**
 * Bowling's anchor writes go through the shared merge-writer
 * (upsertTerminalAnchor in unified-reserve.ts) so tender bookkeeping written
 * by the split routes survives a re-prepare. The finalize-failure rewrite
 * path (which stamps a paymentId) keeps using stampTerminalPaymentOnAnchor.
 */

// Square Loyalty constants for reward redemption during booking
const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
function sqLoyaltyHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Square-Version": "2024-12-18",
    "Content-Type": "application/json",
  };
}

interface ConfirmRetryEntry {
  neonId: number;
  centerId: number;
  qamfReservationId: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  depositCents: number;
  queuedAt: string;
}

/**
 * POST /api/bowling/v2/reserve
 *
 * Main booking endpoint shared by KBF and open bowling.
 *
 * Flow:
 *  1. Validate request
 *  2. Load Square products for each requested line item; compute subtotals
 *  3. Create QAMF reservation (always $0 — QAMF constraint)
 *  4. If any items have price > 0:
 *     POST to /api/square/bowling-orders
 *       → day-of order created with county sales tax
 *       → deposit = depositPct% of tax-inclusive day-of total
 *       → deposit order closed immediately
 *  5. Insert bowling_reservations row + lines into Neon
 *  6. Return IDs + confirmation path
 *
 * Request body: see ReserveBody below.
 * Response: ReserveResponse
 */

const CENTER_CODE_TO_ID: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
  [FASTTRAX_CENTER_CODE]: FASTTRAX_QAMF_CENTER_ID,
};

/**
 * KBF Square catalog variation tokens.
 * Source: Game Bowling.xlsx + VIP.xlsx
 *
 * Regular lanes:
 *   Adult Game Mon-Thur  $5/game    Adult Game Fri-Sun  $6/game
 * VIP lanes (+$1/person/game for ALL bowlers):
 *   Adult Game Mon-Thur VIP $6/game   Adult Game Fri-Sun VIP $7/game
 *   Kids Bowl Free VIP (2) $2/session  Families Bowl Free VIP (2) $2/session
 */
// KBF/FBF VIP + adult-game catalog IDs now live in
// ~/features/booking/service/kbf-pricing (shared with the quote endpoint via
// buildKbfExtraSquareLineItems).
// KBF_GAMES_PER_SESSION / KBF_VIP_PER_GAME_CENTS now live in
// ~/features/booking/service/kbf-pricing (shared with the booking UI).

const QAMF_CENTER_ID_TO_CODE: Record<number, string> = {
  9172: "TXBSQN0FEKQ11",
  3148: "PPTR5G2N0QXF7",
  [FASTTRAX_QAMF_CENTER_ID]: FASTTRAX_CENTER_CODE,
};

interface Player {
  name: string;
  shoeSize?: string | null;
  bumpers?: boolean | null;
  /** KBF linkage — present when this player is a KBF pass member. */
  kbfPassId?: number | null;
  kbfMemberSlot?: number | null;
  kbfRelation?: "kid" | "family" | null;
  /** True for paid adults in KBF bookings (non-FBF adults / guest adults). */
  isPaidAdult?: boolean;
}

interface LineItemRequest {
  squareProductId: number;
  quantity: number;
  /**
   * Square catalog modifier option catalog_object_ids selected by the customer
   * (e.g. pizza topping, soda flavor for pizza-bowl packages).
   * Forwarded to bowling-orders as applied_modifiers on the day-of order line item.
   */
  modifiers?: Array<{ catalog_object_id: string }>;
  /**
   * Free-text note attached to this line item in Square.
   * Used as a fallback when Square catalog modifier groups are not yet configured.
   */
  note?: string;
}

/**
 * $0 pass-through items that don't exist in bowling_square_products but must
 * appear as separate Square order line items (e.g. Pizza Bowl Pizza, Soda Pitcher).
 * Not tracked in bowling_reservation_lines (they're $0 and visible in Square).
 */
interface RawLineItemRequest {
  catalogObjectId: string;
  name: string;
  quantity: number;
  modifiers?: Array<{ catalog_object_id: string }>;
  note?: string;
}

interface ReserveBody {
  /**
   * Discount code applied during the booking flow (uppercased).
   * The Square day-of order created at the quote step already has the
   * matching catalog discount attached — this field is here so the reserve
   * route can re-validate and log a redemption row + bump uses_count.
   */
  discountCode?: string;
  /** YYYY-MM-DD of the booking date — needed for weekday-gated codes. */
  bookingDate?: string;
  /**
   * USA250-style price-key promo code (uppercased). Distinct from
   * `discountCode` (order-level Square catalog discount): a price-key promo
   * REDUCES each eligible line's price directly and attaches no Square
   * discount object. Only the CODE is trusted from the client — eligibility
   * and the percent come from Neon via `evaluateCode`, so this route charges
   * the discounted price even on the fallback path (no pre-created quote
   * order), and records the redemption on both paths.
   */
  promoCode?: string;
  /** QAMF center ID. Exactly one of centerId / centerCode must be provided. */
  centerId?: number;
  centerCode?: string;
  webOfferId: number;
  /** QAMF option ID (game/time/unlimited). */
  optionId?: number;
  optionType?: "Game" | "Time" | "Unlimited";
  /** Experience slug (e.g. "world-cup-vip-mon-thur") — drives the World Cup
   *  fixture/center validation + staff banner when it's a world-cup-* slug. */
  experienceSlug?: string;
  /** Where the booking originated. Only "kiosk" is accepted from the client
   *  (in-center self-service kiosk); anything else records as "web". */
  bookingSource?: string;
  /** ISO 8601 with UTC offset, e.g. "2026-05-15T14:00:00-04:00" */
  bookedAt: string;
  /** 'BookForLater' for advance reservations (default); 'PlayNow' for walk-in */
  service?: "BookForLater" | "PlayNow";
  players: Player[];
  guest: { name: string; email: string; phone: string };
  /** Items being purchased (may be empty for free KBF bookings) */
  lineItems?: LineItemRequest[];
  /**
   * $0 pass-through items added directly to the Square day-of order without
   * Neon lookup (e.g. Pizza Bowl Pizza, Pizza Bowl Soda Pitcher per lane).
   * Appended to sqLineItems in the fallback path when no dayofOrderId is provided.
   */
  rawItems?: RawLineItemRequest[];
  /** Square Web Payments SDK nonce. Required when any item has a charge. */
  squareToken?: string;
  /** Square gift card nonce — optional. Multi-tender: GC covers up to
   *  its balance, squareToken (card/wallet) covers the remainder. */
  giftCardNonce?: string;
  /**
   * How squareToken was produced (PaymentForm tag). Drives the card-vault
   * silent capture — wallet tokens / gift-card-only tenders are never vaulted.
   */
  sourceKind?: PaymentSourceKind;
  /** Checkout opt-in: "Save this card to my account for faster checkout"
   *  ⇒ the captured card is kept permanently (never auto-disabled). */
  saveCardConsent?: boolean;
  squareCustomerId?: string;
  locationId?: string;
  notes?: string;
  /**
   * KIOSK direct-Terminal (owner: NO saved card). Two-phase, mirroring the
   * unified racing rail:
   *  - prepareOnly + terminalSeed → create the GIFT_CARD deposit order the paired
   *    reader will charge, write a recoverable anchor, and return WITHOUT touching
   *    QAMF/Neon (nothing else moves before the tap).
   *  - externalPayment → the reader already captured the card against that order;
   *    reserve records it (finalize funds the gift card, NEVER re-charges).
   * The seed rides on externalPayment so finalize recreates the exact order the
   * reader paid, independent of any QAMF hold→fresh fallback.
   */
  prepareOnly?: boolean;
  terminalSeed?: string;
  /**
   * KIOSK: Game Zone cards riding this bowling cart (owner 2026-07-18) — the
   * card lines join the DEPOSIT order and the reader charge; fulfillment runs
   * on the kiosk confirmation. Selection pointers only; the server re-derives
   * every price from TOKEN_PACKAGES. Sent on BOTH prepareOnly and the finalize
   * call (same session), so the idempotent order re-derivation byte-matches.
   */
  gameCardPurchase?: {
    mode: "new_card" | "reload";
    cards: Array<{ packageId: string; accountNumber?: string }>;
  };
  /** Intercard location code for the cards (kiosk center/brand derived). */
  gameCardLocationCode?: number;
  externalPayment?: {
    paymentId: string;
    depositOrderId: string;
    amountCents: number;
    seed: string;
    /** SPLIT checkouts (kiosk v1: gift card + tap): EVERY captured payment on
     *  the deposit order — finalize verifies the SUM. Absent = single tap. */
    paymentIds?: string[];
  };
  /**
   * Pre-created Square day-of order ID from the quote step.
   * When provided, bowling-orders skips creating the day-of order.
   */
  dayofOrderId?: string;
  /** Tax-inclusive total of the pre-created day-of order (cents). */
  dayofTotalCents?: number;
  /**
   * Pre-computed deposit amount from the quote step (cents, tax-inclusive).
   * When provided this is used as-is for the deposit charge — no recalculation.
   * This ensures the charged amount is identical to the amount shown to the user.
   */
  depositCents?: number;
  /**
   * Extra pizza topping surcharge (cents). 1 topping included per lane,
   * $1 each additional. Added as an ad-hoc line item on the Square order.
   */
  extraToppingsCents?: number;
  /**
   * Booking flow kind — drives product_kind stored on the reservation row.
   * 'kbf' for Kids Bowl Free; 'open' for open / Fun 4 All bowling; 'hourly' for hourly rental.
   * Defaults to 'open' if omitted (backward-compatible).
   */
  kind?: "kbf" | "open" | "hourly";
  /**
   * Pre-created QAMF Temporary reservation ID from the hold-first flow.
   * When provided, we skip createReservation and instead update the guest
   * info + confirm the existing hold. If confirmation fails (hold expired),
   * we fall back to creating a fresh reservation.
   */
  qamfReservationId?: string;
  /**
   * Whether the customer opted in to SMS confirmation.
   * Passed through to the bowling-confirmation notification route.
   */
  smsOptIn?: boolean;
  /**
   * Play Now (per-lane duckpin QR / "bowl now"): the guest is standing at the
   * lane, so turn it on SERVER-SIDE right at payment (Arrived → Ready →
   * Running) and SUPPRESS both the booking-confirmation email/SMS and the
   * lane-ready notification. Bowling-only carts hit this route; a mixed cart
   * with added attractions goes through unified-reserve and keeps its email.
   */
  playNow?: boolean;
  // ── Loyalty reward redemption ─────────────────────────────────────
  /** Square Loyalty reward tier ID to redeem (e.g. "$10 off F&B"). */
  rewardTierId?: string;
  /** Square Loyalty account ID (owner of the reward). */
  loyaltyAccountId?: string;
  /** Discount amount in cents from the selected reward tier. */
  rewardDiscountCents?: number;
  /** Loyalty action during booking: 'signup' (new account) or 'existing' (logged in). */
  loyaltyAction?: "signup" | "existing";
  /** Add $2.99 booking fee to the day-of order (non-$0 reservations only). */
  bookingFee?: boolean;
  /**
   * Booked-pricing stamp inputs (persisted to booking_metadata.bowling so the
   * reservation-edit repricer knows HOW the primary line was quantified).
   * pricingMode is derived SERVER-side from kind/experienceSlug — only the
   * lane/duration facts the server can't derive come from the client.
   */
  bookingMeta?: { laneCount?: number; durationMultiplier?: number };
  // ── Attraction add-ons (laser tag / gel blaster booked via BMI) ──
  /** Attraction bookings made during the wizard. Stored on the reservation for tracking. */
  attractionBookings?: Array<{
    slug: string;
    name: string;
    bmiOrderId: string | null;
    bmiBillLineId: string | null;
    squareCatalogObjectId: string | null;
    quantity: number;
    totalPriceDollars: number;
    timeSlot: string;
    timeLabel: string;
  }>;
}

export async function POST(req: NextRequest) {
  let body: ReserveBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // ── Resolve center IDs ──────────────────────────────────────────
  let centerId: number;
  let centerCode: string;
  if (body.centerId) {
    centerId = body.centerId;
    const code = QAMF_CENTER_ID_TO_CODE[centerId];
    if (!code) {
      return NextResponse.json({ error: `unknown centerId: ${centerId}` }, { status: 400 });
    }
    centerCode = code;
  } else if (body.centerCode) {
    centerCode = body.centerCode;
    const id = CENTER_CODE_TO_ID[centerCode];
    if (!id) {
      return NextResponse.json({ error: `unknown centerCode: ${centerCode}` }, { status: 400 });
    }
    centerId = id;
  } else {
    return NextResponse.json({ error: "centerId or centerCode required" }, { status: 400 });
  }

  // ── KIOSK direct-Terminal PREPARE ───────────────────────────────
  // Runs BEFORE the full-booking required-fields gate: create the GIFT_CARD
  // deposit order the reader will charge, persist a recoverable anchor, then STOP
  // — no QAMF, no Neon (nothing that can fail after money would move). The reader
  // charges this exact order; reserve later finalizes it via externalPayment.
  // depositCents is authoritative (the kiosk always quotes), so what the reader
  // shows == charges == what reserve records.
  if (body.prepareOnly) {
    const seed = body.terminalSeed;
    if (!seed) {
      return NextResponse.json({ error: "terminalSeed required for prepareOnly" }, { status: 400 });
    }
    const depositForReader = body.depositCents ?? 0;
    if (!(depositForReader > 0)) {
      return NextResponse.json(
        { error: "depositCents required (and > 0) for a terminal deposit" },
        { status: 400 },
      );
    }
    const prepLocationId = body.locationId ?? centerCode;
    try {
      // Game Zone cards riding this cart: resolve server-side (never trust
      // client cents), persist a ledger row per card BEFORE the order exists,
      // and stash the pointers on the anchor for finalize. Mirrors the unified
      // rail exactly.
      const gz =
        kioskGzCartEnabled() && body.gameCardPurchase
          ? resolveCartPurchase(body.gameCardPurchase)
          : null;
      const gzCents = gz?.totalCents ?? 0;
      // Checkout-upsell cards: one per person on the transaction (owner
      // 2026-07-21). PREPARE is the authoritative gate — finalize must
      // byte-match the prepared order, so it can't smuggle extras past this.
      if (gz) {
        const upsellCards = gz.cards.filter((c) => c.pkg.upsell).length;
        if (upsellCards > Math.max(1, body.players?.length ?? 0)) {
          return NextResponse.json(
            { error: "Discounted Game Zone cards are limited to one per player." },
            { status: 422 },
          );
        }
      }
      let anchorGameCards: AnchorGameCards | undefined;
      if (gz) {
        const gzLoc = body.gameCardLocationCode;
        if (typeof gzLoc !== "number") {
          return NextResponse.json(
            { error: "gameCardLocationCode required for Game Zone cards" },
            { status: 400 },
          );
        }
        const groupId = randomUUID();
        const cards: AnchorGameCards["cards"] = [];
        for (const c of gz.cards) {
          const txnId = randomUUID();
          await startTxn({
            txnId,
            groupId,
            kind: gz.mode,
            locationCode: gzLoc,
            accountNumber: c.accountNumber,
            packageId: c.packageId,
            tokens: c.pkg.tokens,
            bonusTokens: c.pkg.bonusTokens,
            amountCents: c.pkg.priceCents,
            tpiTransactionId: `${gz.mode === "new_card" ? "newcard" : "reload"}-${txnId}`,
            contact: body.guest?.email
              ? { name: body.guest.name, email: body.guest.email, phone: body.guest.phone }
              : undefined,
          });
          cards.push({ txnId, packageId: c.packageId, accountNumber: c.accountNumber });
        }
        anchorGameCards = {
          mode: gz.mode,
          groupId,
          locationCode: gzLoc,
          totalCents: gzCents,
          cards,
        };
      }
      const { depositOrderId } = await createDepositOrder({
        baseKey: seed,
        locationId: prepLocationId,
        amountCents: depositForReader,
        note: `Kiosk deposit ${seed.slice(0, 12)}`,
        asGiftCardLine: true,
        extraLines: gz?.orderLines,
      });
      // Split-tender session secret (gift card + tap) — minted at PREPARE, the
      // session's trust root, exactly like the unified rail. Returned ONLY to
      // this prepare's caller; every gift-card route requires it. Token handed
      // out only when the anchor durably landed (a token without an anchor
      // lights the gift-card UI and then answers "no-session" to every use).
      const written = await upsertTerminalAnchor(seed, {
        depositOrderId,
        depositCents: depositForReader,
        locationId: prepLocationId,
        baseKey: seed,
        splitToken: randomUUID(),
        // The reader charges the ORDER TOTAL: booking deposit + card lines.
        totalCents: depositForReader + gzCents,
        source: "bowling",
        ...(anchorGameCards ? { gameCards: anchorGameCards } : {}),
      });
      const splitToken = written?.splitToken;
      console.log(
        `[bowling/v2/reserve] TERMINAL PREPARE seed=${seed} order=${depositOrderId} deposit=${depositForReader}c gz=${gzCents}c loc=${prepLocationId} split=${!!splitToken}`,
      );
      // The reader charges the ORDER TOTAL: booking deposit + card lines.
      return NextResponse.json({
        seed,
        depositOrderId,
        depositCents: depositForReader + gzCents,
        ...(splitToken ? { splitToken, ambient: kioskAmbientCheckoutEnabled() } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "prepare failed";
      console.error("[bowling/v2/reserve] TERMINAL PREPARE failed:", msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  const { webOfferId, bookedAt, players, guest, lineItems = [], notes } = body;
  const service = body.service ?? "BookForLater";

  if (!webOfferId || !bookedAt || !players?.length || !guest?.name) {
    return NextResponse.json(
      { error: "webOfferId, bookedAt, players, and guest are required" },
      { status: 400 },
    );
  }

  // Game Zone cards ride ONLY the kiosk reader rail — fail closed so a typed
  // card payment can never silently drop paid-for cards.
  if (body.gameCardPurchase?.cards?.length && !body.externalPayment) {
    return NextResponse.json(
      { error: "Game Zone cards in the cart require the reader payment." },
      { status: 400 },
    );
  }

  // ── Square customer resolution (audience link for marketing) ─────
  // Every reservation gets a Square customer linked, even non-rewards
  // bookings. Lets the post-visit survey flow (PR-GS2) find the customer
  // by Square id rather than re-searching by phone. The client may pass
  // squareCustomerId for logged-in rewards members; for everyone else we
  // resolve by phone (+ name fallback). Failure is non-fatal — booking
  // continues without it.
  let resolvedSquareCustomerId: string | undefined = body.squareCustomerId;
  let resolvedPhoneE164: string | undefined;
  if (guest.phone) {
    if (!resolvedSquareCustomerId) {
      try {
        const { firstName, lastName } = splitGuestName(guest.name);
        const audience = await resolveAudienceMember({
          phone: guest.phone,
          firstName,
          lastName,
          email: guest.email || undefined,
        });
        resolvedSquareCustomerId = audience.squareCustomerId;
        resolvedPhoneE164 = audience.phoneE164;
      } catch (err) {
        console.warn(
          "[bowling/v2/reserve] audience resolve failed (non-fatal):",
          err instanceof Error ? err.message : err,
        );
      }
    }
    // Fall back to a fresh normalize when the audience resolve didn't run
    // (rewards-member path supplies squareCustomerId already).
    if (!resolvedPhoneE164) {
      try {
        resolvedPhoneE164 = normalizePhoneE164(guest.phone);
      } catch {
        // Phone unparseable — skip marketing opt-in below.
      }
    }
  }

  // ── Marketing opt-in (mirrors transactional smsOptIn) ────────────
  // When a customer agrees to SMS confirmation at booking, also enroll
  // them in marketing. STOP replies (handled by the inbound SMS webhook
  // in PR-GS6) flip them back out. Fire-and-forget; never blocks booking.
  const smsOptInAtBooking = body.smsOptIn ?? true;
  if (smsOptInAtBooking && resolvedPhoneE164) {
    recordOptIn({
      phoneE164: resolvedPhoneE164,
      source: "booking_confirmation",
    }).catch((err) =>
      console.warn("[bowling/v2/reserve] marketing opt-in record failed (non-fatal):", err),
    );
  }

  // ── USA250-style price-key promo (server-authoritative) ─────────
  // The quote path bakes the same reduction into the pre-created order's
  // lines; re-deriving it here from the Neon row makes the FALLBACK path (no
  // quote order) charge the same discounted price the review displayed, and
  // gives both paths a redemption ledger row. Client-sent amounts are never
  // trusted — only the code; window/domain/percent all come from Neon.
  // Mirrors the client seam (promo-pricing.ts): percent codes only, unit
  // price rounded per line, KBF extras + booking fee never discounted.
  let promoPriceFactor = 1;
  let promoRow: Awaited<ReturnType<typeof getDiscountCodeByCode>> = null;
  let promoSavingsCents = 0;
  if (body.promoCode) {
    try {
      const row = await getDiscountCodeByCode(body.promoCode);
      const evald = evaluateCode(row, {
        code: body.promoCode,
        domain: "bowling",
        locationId: centerCode,
        bookingDate: body.bookedAt.slice(0, 10),
      });
      if (evald.valid && row?.mechanic === "percent" && row.amountPct != null) {
        promoPriceFactor = 1 - row.amountPct / 100;
        promoRow = row;
      } else if (!evald.valid) {
        console.warn(
          `[bowling/v2/reserve] promo ${body.promoCode} not valid here (${evald.reason}) — charging full price`,
        );
      }
    } catch (err) {
      console.error("[bowling/v2/reserve] promo validation failed (treated as no promo):", err);
    }
  }

  // ── World Cup VIP Bowling (fail-closed, server-authoritative) ────
  // Bowling-only carts reserve through THIS route (mixed carts run the same
  // check in unified-reserve), so the fixture/center validation lives here
  // too: a stale or doctored client can't book a disabled center or a
  // non-kickoff start. Rejects BEFORE any QAMF confirm or Square write.
  let wcFixture: WorldCupFixture | null = null;
  if (isWorldCupSlug(body.experienceSlug)) {
    try {
      wcFixture = validateWorldCupBooking({ centerQamfId: centerId, bookedAt: body.bookedAt });
    } catch (err) {
      if (err instanceof WorldCupReservationError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
      }
      throw err;
    }
    if (body.optionId == null) {
      return NextResponse.json(
        { error: "World Cup booking is missing its lane time option — please re-pick your match." },
        { status: 400 },
      );
    }
    // Live team names for the staff banner + metadata (fail-soft, cached).
    wcFixture = await enrichFixture(wcFixture!);
  }

  // ── Load Square products + compute subtotals ────────────────────
  const productItems: { product: BowlingSquareProduct; quantity: number; unitCents: number }[] = [];
  const reservationLines: ReservationLine[] = [];

  for (const li of lineItems) {
    if (li.quantity < 1) continue;
    const product = await getBowlingSquareProduct(li.squareProductId);
    if (!product) {
      return NextResponse.json(
        { error: `squareProductId ${li.squareProductId} not found` },
        { status: 400 },
      );
    }
    // Promo-reduced unit price (same per-line rounding as the client/quote).
    const unitCents =
      promoPriceFactor === 1 || product.priceCents <= 0
        ? product.priceCents
        : Math.round(product.priceCents * promoPriceFactor);
    promoSavingsCents += (product.priceCents - unitCents) * li.quantity;
    productItems.push({ product, quantity: li.quantity, unitCents });
    reservationLines.push({
      squareProductId: product.id,
      label: product.label,
      quantity: li.quantity,
      unitPriceCents: unitCents,
    });
  }

  // ── Midnight Madness sales window (fail-closed, server-authoritative) ──
  // MM rides the all-day Fri-Sun Time offer (its dedicated QAMF Unlimited
  // offers reject every create — vendor ticket open, 2026-08-01), so the
  // webOfferId can NOT scope its window and the client slot gates are
  // display-only (2026-08-01 incident: MM booked hours before its window).
  // Recognize an MM booking by slug or by its Square product lines — every MM
  // booking carries one, that's where its per-person price comes from — and
  // reject any start outside Fri/Sat 11:45 PM+ ET BEFORE any QAMF confirm or
  // Square write.
  const isMidnightMadness =
    isMidnightMadnessSlug(body.experienceSlug) ||
    productItems.some((p) => MM_CATALOG_OBJECT_IDS.has(p.product.squareCatalogObjectId));
  if (isMidnightMadness) {
    const mmWindowError = midnightMadnessWindowError(bookedAt);
    if (mmWindowError) {
      console.log(`[bowling/v2/reserve] MM window rejected: bookedAt=${bookedAt}`);
      return NextResponse.json(
        { error: mmWindowError, code: "mm_outside_window" },
        { status: 400 },
      );
    }
  }

  // ── Determine product kind ──────────────────────────────────────
  // Moved above totals so adult game charges are included in payment validation.
  const productKind: "kbf" | "open" =
    body.kind === "kbf"
      ? "kbf"
      : body.kind === "open"
        ? "open"
        : players.some((p) => p.kbfPassId)
          ? "kbf"
          : "open";

  // ── KBF: VIP detection (server-side — never trust client) ────────
  // Look up the experience to determine VIP status from the webOfferId.
  // This must run before pricing so VIP upcharges are included.
  let kbfIsVip = false;
  if (productKind === "kbf") {
    const experience = await getBowlingExperienceByOffer(centerCode, webOfferId, "kbf");
    kbfIsVip = experience?.isVip ?? false;
  }

  // ── KBF: adult game pricing (server-side — never trust client) ───
  // Kids Bowl Free = kids bowl free, adults pay per game.
  // Families Bowl Free = everyone bowls free (no paid adults).
  // VIP = $1/game extra for ALL bowlers (adults pay $6/$7 instead of $5/$6).
  const paidAdultCount = productKind === "kbf" ? players.filter((p) => p.isPaidAdult).length : 0;
  const bookedDateYmd = bookedAt.slice(0, 10); // YYYY-MM-DD
  const bookedDow = new Date(`${bookedDateYmd}T12:00:00`).getDay();
  const isFriday = bookedDow === 5;
  // VIP adults pay $1 more per game ($6/$7 vs $5/$6)
  const adultPerGameCents = kbfAdultPerGameCents(kbfIsVip, isFriday);
  const adultGameTotalCents = paidAdultCount * adultPerGameCents * KBF_GAMES_PER_SESSION;
  const adultGameLabel = kbfIsVip
    ? isFriday
      ? "Adult Game Fri-Sun VIP"
      : "Adult Game Mon-Thur VIP"
    : isFriday
      ? "Adult Game Fri-Sun"
      : "Adult Game Mon-Thur";

  if (adultGameTotalCents > 0) {
    reservationLines.push({
      label: adultGameLabel,
      quantity: paidAdultCount * KBF_GAMES_PER_SESSION,
      unitPriceCents: adultPerGameCents,
    });
  }

  // ── KBF: VIP upcharge for free bowlers ($1/game × 2 games) ─────
  // VIP lanes cost $1 extra per game per person — applies to free kids
  // and FBF adults. Paid adults already have VIP baked into their rate above.
  let kbfVipUpchargeCents = 0;
  if (kbfIsVip) {
    const freeBowlerCount = players.filter((p) => !p.isPaidAdult).length;
    kbfVipUpchargeCents = freeBowlerCount * KBF_VIP_PER_GAME_CENTS * KBF_GAMES_PER_SESSION;
    if (kbfVipUpchargeCents > 0) {
      // Separate VIP upcharge by bowler type for catalog-linked Square reporting
      const kbfKidCount = players.filter((p) => !p.isPaidAdult && p.kbfRelation === "kid").length;
      const fbfAdultCount = freeBowlerCount - kbfKidCount;
      // Kids Bowl Free VIP line
      if (kbfKidCount > 0) {
        reservationLines.push({
          label: "Kids Bowl Free VIP",
          quantity: kbfKidCount, // 1 unit = 2 games at $1/game = $2
          unitPriceCents: KBF_VIP_PER_GAME_CENTS * KBF_GAMES_PER_SESSION, // $2 per bowler
        });
      }
      // Families Bowl Free VIP line (FBF adults)
      if (fbfAdultCount > 0) {
        reservationLines.push({
          label: "Families Bowl Free VIP",
          quantity: fbfAdultCount,
          unitPriceCents: KBF_VIP_PER_GAME_CENTS * KBF_GAMES_PER_SESSION, // $2 per bowler
        });
      }
    }
  }

  // Persist the $0 Pizza Bowl food selections (pizza + soda, with topping /
  // drink notes) as reservation lines so the order is SAVED in Neon and stays
  // recoverable / visible on the admin board — previously rawItems were
  // transient (Square-only) and lost when they failed to reach the order.
  // Pricing is computed from productItems (not reservationLines), so $0 food
  // lines don't change any total; the product-backed Square map ignores lines
  // with no squareProductId, so they are not double-added to the day-of order.
  for (const ri of body.rawItems ?? []) {
    reservationLines.push({
      label: ri.note ? `${ri.name} — ${ri.note}` : ri.name,
      quantity: ri.quantity,
      unitPriceCents: 0,
    });
  }

  // Booking fee: $2.99, 100% deposit, catalog item 7VKAFU3HDPRSKY7ZB6CKXTRW
  const BOOKING_FEE_CENTS = 299;
  const BOOKING_FEE_CATALOG_ID = "7VKAFU3HDPRSKY7ZB6CKXTRW";
  const hasBookingFee = body.bookingFee === true;

  // Pre-tax subtotal (used to compute overallDepositPct + squareToken validation)
  const productTotal = productItems.reduce(
    (s, { unitCents, quantity }) => s + unitCents * quantity,
    0,
  );
  // Adult game + VIP upcharge are 100% deposit (pay upfront, no day-of split).
  const kbfExtraCents = adultGameTotalCents + kbfVipUpchargeCents;
  const preTaxTotalCents = productTotal + kbfExtraCents + (hasBookingFee ? BOOKING_FEE_CENTS : 0);
  const productDeposit = productItems.reduce(
    (s, { product, quantity, unitCents }) =>
      s + Math.round(unitCents * quantity * (product.depositPct / 100)),
    0,
  );
  const preTaxDepositCents =
    productDeposit + kbfExtraCents + (hasBookingFee ? BOOKING_FEE_CENTS : 0);

  // Weighted-average deposit % across all line items — passed to bowling-orders
  // so it can apply the same proportion to the tax-inclusive total.
  const overallDepositPct =
    preTaxTotalCents > 0 ? Math.round((preTaxDepositCents / preTaxTotalCents) * 100) : 100;

  // Any items with a charge require a payment token — UNLESS a loyalty
  // reward covers the entire deposit (client sends depositCents: 0).
  const needsPayment = preTaxTotalCents > 0;
  const effectiveClientDeposit = body.depositCents ?? preTaxTotalCents; // pre-tax fallback
  if (
    needsPayment &&
    effectiveClientDeposit > 0 &&
    !body.squareToken &&
    !body.giftCardNonce &&
    !body.externalPayment
  ) {
    return NextResponse.json(
      { error: "squareToken or giftCardNonce required when deposit > 0" },
      { status: 400 },
    );
  }

  // ── KBF: per-day redemption cap (2 free games = 1 session/day) ──
  if (productKind === "kbf") {
    const kbfPairs = players
      .filter((p) => p.kbfPassId && p.kbfMemberSlot != null && !p.isPaidAdult)
      .map((p) => ({ passId: p.kbfPassId!, slot: p.kbfMemberSlot! }));
    if (kbfPairs.length > 0) {
      const bookedDate = body.bookedAt.slice(0, 10); // YYYY-MM-DD
      try {
        const alreadyRedeemed = await getKbfRedeemedMembers(bookedDate, kbfPairs);
        if (alreadyRedeemed.length > 0) {
          const names = alreadyRedeemed.map((r) => {
            const p = players.find(
              (pl) => pl.kbfPassId === r.passId && pl.kbfMemberSlot === r.slot,
            );
            return p?.name ?? "a bowler";
          });
          return NextResponse.json(
            {
              error: `${names.join(", ")} already used their free games for ${bookedDate}. Remove them or add them as paid adults.`,
            },
            { status: 409 },
          );
        }
      } catch (err) {
        console.error("[bowling/v2/reserve] redemption check failed (non-fatal):", err);
        // Continue — don't block booking on a failed check
      }
    }
  }

  // ── Build QAMF option object ────────────────────────────────────
  const optionType = body.optionType ?? "Game";
  const optionId = body.optionId;

  const qamfOptions: {
    Game?: { Id: number }[];
    Time?: { Id: number }[];
    Unlimited?: { Id: number }[];
  } = {};
  if (optionId) {
    if (optionType === "Time") qamfOptions.Time = [{ Id: optionId }];
    else if (optionType === "Unlimited") qamfOptions.Unlimited = [{ Id: optionId }];
    else qamfOptions.Game = [{ Id: optionId }];
  }

  // Duration/option guard (pre-charge, so a 409 is safe): hold-first path
  // gets config-only validation (the hold already probed at creation; the
  // body's optionId is client-controlled and must still belong to the offer);
  // the fresh path gets the full occupancy-window check. Fail-open on guard
  // infrastructure errors.
  try {
    await assertBookable({
      centerId,
      webOfferId,
      optionId,
      optionType,
      bookedAt,
      players: players.length,
      mode: body.qamfReservationId ? "config-only" : "full",
      logTag: "[bowling/v2/reserve]",
    });
  } catch (err) {
    if (err instanceof DurationGuardError) {
      console.log(`[bowling/v2/reserve] guard rejected (${err.code}): ${err.message}`);
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.warn("[bowling/v2/reserve] duration guard errored (fail-open):", err);
  }

  // ── QAMF reservation — hold-first or fresh ──────────────────────
  // If the wizard pre-created a Temporary hold (hold-first flow), we:
  //   1. Update the customer info on the hold
  //   2. Confirm the hold (Temporary → Confirmed)
  //   3. If confirm fails (hold expired or customer not accepted), fall back
  //      to a fresh createReservation + explicit PUT /customer + confirm.
  // Otherwise we create a fresh reservation directly.
  //
  // qamfConfirmed tracks whether the /status PATCH actually took effect.
  // When a paid booking's confirmation fails, the Neon row is stored as
  // 'confirm_pending' and queued for automatic retry by the cron.
  let qamfReservationId: string;
  let qamfConfirmed = false;
  let qamfLanes: Array<{ Id?: string; LaneNumber: number }> = [];

  // ── Build Conqueror notes with payment summary ──────────────────
  // Staff see these in the Conqueror reservation panel.
  // Format: "Fun 4 All (1.5hr) $54.00 + 4x Shoe Rental $24.00 | Deposit $60.00 paid"
  // Free bookings (KBF, no add-ons) omit the payment line.
  function buildQamfNotes(): string | undefined {
    const parts: string[] = [];

    if (reservationLines.length > 0) {
      const itemParts = reservationLines.map((l) => {
        const total = l.quantity * l.unitPriceCents;
        const totalStr = `$${(total / 100).toFixed(2)}`;
        return l.quantity > 1 ? `${l.quantity}x ${l.label} ${totalStr}` : `${l.label} ${totalStr}`;
      });
      parts.push(itemParts.join(" + "));
    }

    if (preTaxDepositCents > 0) {
      // Use the pre-tax figure here since Square tax happens after this call.
      // The actual charged amount will be in squareDepositPaymentId later.
      parts.push(`Deposit $${(preTaxDepositCents / 100).toFixed(2)} paid`);
    }

    const summary = parts.join(" | ");
    if (!summary && !notes) return undefined;
    if (!summary) return notes;
    if (!notes) return summary;
    return `${summary}\n${notes}`;
  }

  const qamfNotes = buildQamfNotes();

  /** Attach customer then confirm — used by fresh reservation paths. */
  async function attachAndConfirm(reservationId: string): Promise<boolean> {
    // QAMF requires an explicit PUT /customer BEFORE /status will confirm.
    await setReservationCustomer(centerId, reservationId, {
      Guest: {
        Name: guest.name,
        PhoneNumber: guest.phone,
        Email: guest.email,
      },
    });
    return setReservationStatus(centerId, reservationId, "Confirmed");
  }

  if (body.qamfReservationId) {
    // ── Hold-first path ──────────────────────────────────────────
    qamfReservationId = body.qamfReservationId;

    // Attach customer + rename title + set notes all in parallel.
    // Customer attach MUST succeed before /status PATCH will take effect.
    // Title rename and notes are fire-and-forget — non-fatal.
    // If the customer attach fails (hold expired) we fall through to fresh.
    let holdCustomerAttached = false;
    try {
      await Promise.all([
        // 1. Attach guest — required before /status will confirm
        setReservationCustomer(centerId, qamfReservationId, {
          Guest: {
            Name: guest.name,
            PhoneNumber: guest.phone,
            Email: guest.email,
          },
        }),
        // 2. Rename "Hold (Np)" → "Guest Name (Np)" and write payment notes
        patchReservation(centerId, qamfReservationId, {
          Title: `${guest.name} (${players.length}p)`,
          Notes: qamfNotes,
        }).catch((err) =>
          console.warn("[bowling/v2/reserve] hold patch (title/notes) failed (non-fatal):", err),
        ),
      ]);
      holdCustomerAttached = true;
    } catch (err) {
      console.warn(
        "[bowling/v2/reserve] setReservationCustomer (hold) failed — treating hold as expired:",
        err instanceof Error ? err.message : err,
      );
    }

    if (holdCustomerAttached) {
      // Customer is attached; PATCH /status should take effect.
      qamfConfirmed = await setReservationStatus(centerId, qamfReservationId, "Confirmed");
      if (!qamfConfirmed) {
        console.warn(
          `[bowling/v2/reserve] setReservationStatus returned false for hold ${qamfReservationId} — creating fresh reservation`,
        );
      }
    }

    if (!qamfConfirmed) {
      // Hold expired or confirm rejected — create a fresh reservation as fallback
      try {
        const reservation = await createReservation(centerId, {
          BookedAt: bookedAt,
          Title: `${guest.name} (${players.length}p)`,
          Notes: qamfNotes,
          Customer: {
            Guest: {
              Name: guest.name,
              PhoneNumber: guest.phone,
              Email: guest.email,
            },
          },
          WebOffer: {
            Id: webOfferId,
            Options: qamfOptions,
            Services: [service],
          },
          TotalPlayers: players.length,
        });
        qamfReservationId = reservation.Id;
        qamfLanes = reservation.Lanes ?? [];
        console.log(
          `[bowling/v2/reserve] fallback fresh reservation created: ${qamfReservationId}`,
        );
        qamfConfirmed = await attachAndConfirm(qamfReservationId).catch((err) => {
          console.error("[bowling/v2/reserve] attachAndConfirm on fallback failed:", err);
          return false;
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "QAMF reservation failed";
        console.error("[bowling/v2/reserve] fallback QAMF error:", msg);
        return NextResponse.json({ error: `Reservation failed: ${msg}` }, { status: 502 });
      }
    }
  } else {
    // ── Fresh reservation path ───────────────────────────────────
    try {
      const reservation = await createReservation(centerId, {
        BookedAt: bookedAt,
        Title: `${guest.name} (${players.length}p)`,
        Notes: qamfNotes,
        Customer: {
          Guest: {
            Name: guest.name,
            PhoneNumber: guest.phone,
            Email: guest.email,
          },
        },
        WebOffer: {
          Id: webOfferId,
          Options: qamfOptions,
          Services: [service],
        },
        TotalPlayers: players.length,
      });
      qamfReservationId = reservation.Id;
      qamfLanes = reservation.Lanes ?? [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : "QAMF reservation failed";
      console.error("[bowling/v2/reserve] QAMF error:", msg);
      return NextResponse.json({ error: `Reservation failed: ${msg}` }, { status: 502 });
    }

    qamfConfirmed = await attachAndConfirm(qamfReservationId).catch((err) => {
      console.error("[bowling/v2/reserve] attachAndConfirm (fresh) failed:", err);
      return false;
    });
  }

  // ── Fetch lane assignments from QAMF if not already captured ────
  // The hold-first confirmed path doesn't get lanes from createReservation.
  if (qamfLanes.length === 0) {
    try {
      const laneRes = await getReservation(centerId, qamfReservationId);
      qamfLanes = laneRes.Lanes ?? [];
    } catch {
      // Non-fatal
    }
  }

  // ── Push player names to QAMF (KBF has names from registration) ──
  // For KBF bookings we know every player name from the pass. Push them
  // to QAMF so Conqueror shows real names instead of "Player 1".
  // For open bowling, names default to "Bowler N" and get updated later
  // via the confirmation page's "Enter Names" flow.
  if (qamfLanes.length > 0 && players.some((p) => p.name)) {
    const lane = qamfLanes[0];
    const laneId = lane.Id ?? String(lane.LaneNumber);
    setLanePlayers(
      centerId,
      qamfReservationId,
      laneId,
      players.map((p) => ({
        Name:
          productKind === "kbf" ? toLaneInsertName(p.name || "") || "Bowler" : p.name || "Bowler",
        ActivateBumpers: p.bumpers ?? false,
      })),
    ).catch((err) => console.warn("[bowling/v2/reserve] setLanePlayers failed (non-fatal):", err));
  }

  // ── Square payment (gift card deposit + day-of order) ──────────
  let squareDepositOrderId: string | undefined;
  let squareDepositPaymentId: string | undefined;
  let squareDayofOrderId: string | undefined;
  let squareGiftCardId: string | undefined;
  let squareGiftCardGan: string | undefined;
  /** Idempotency base for the deposit charge — also seeds the card-vault
   *  CreateCard key (`cof-${depositBaseKey}`). Set when a deposit is charged. */
  let depositBaseKey: string | undefined;
  let loyaltyRewardId: string | undefined;
  const rewardDiscountCents = body.rewardDiscountCents ?? 0;
  let depositCents = 0; // actual charged amount (tax-inclusive)
  let totalCents = 0; // tax-inclusive day-of order total
  /** KIOSK: charged Game Zone card rows for the confirmation screen to fulfill. */
  let gameCardsResult:
    | {
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
      }
    | undefined;

  if (needsPayment) {
    const squareLocationId = body.locationId ?? centerCode;

    // Build Square line items, passing through catalog IDs, modifier selections, and notes.
    // lineItems (from the request body) carry modifier arrays keyed by squareProductId.
    const sqLineItems = [
      // Product-backed lines (from bowling_square_products table)
      ...reservationLines
        .filter((l) => l.squareProductId != null)
        .map((l) => {
          const product = productItems.find((p) => p.product.id === l.squareProductId)?.product;
          const reqItem = lineItems.find((li) => li.squareProductId === l.squareProductId);
          return {
            name: l.label,
            quantity: String(l.quantity),
            basePriceMoney: { amount: l.unitPriceCents, currency: "USD" as const },
            // Include catalog object ID so Square links to the catalog item for reporting
            ...(product?.squareCatalogObjectId
              ? { catalogObjectId: product.squareCatalogObjectId }
              : {}),
            // Forward modifier selections (e.g. pizza topping, soda flavor) to Square
            ...(reqItem?.modifiers?.length ? { modifiers: reqItem.modifiers } : {}),
            // Forward free-text note (fallback when catalog modifiers not yet configured)
            ...(reqItem?.note ? { note: reqItem.note } : {}),
          };
        }),
      // KBF paid-adult game fees + VIP lane upcharge (kid/FBF-adult split).
      // Built by the shared kbf-pricing helper so this charge order is
      // byte-identical to the /quote order the review screen reuses.
      ...buildKbfExtraSquareLineItems({
        isVip: kbfIsVip,
        isFriday,
        kbfKidCount: players.filter((p) => !p.isPaidAdult && p.kbfRelation === "kid").length,
        fbfAdultCount:
          players.filter((p) => !p.isPaidAdult).length -
          players.filter((p) => !p.isPaidAdult && p.kbfRelation === "kid").length,
        paidAdultCount,
      }),
      // $0 pass-through items (Pizza Bowl Pizza, Soda Pitcher) — not in Neon but
      // must appear as separate Square order line items with modifier selections.
      // Only used in the fallback path; primary path uses the pre-created dayofOrderId.
      ...(body.rawItems ?? []).map((ri) => ({
        name: ri.name,
        quantity: String(ri.quantity),
        basePriceMoney: { amount: 0, currency: "USD" as const },
        catalogObjectId: ri.catalogObjectId,
        ...(ri.modifiers?.length ? { modifiers: ri.modifiers } : {}),
        ...(ri.note ? { note: ri.note } : {}),
      })),
      // Extra pizza topping surcharge ($1 each beyond the 1 included)
      ...(body.extraToppingsCents && body.extraToppingsCents > 0
        ? [
            {
              name: "Extra Pizza Topping",
              quantity: String(body.extraToppingsCents / 100),
              basePriceMoney: { amount: 100, currency: "USD" as const },
            },
          ]
        : []),
      // Booking fee — catalog-priced (no basePriceMoney override)
      ...(hasBookingFee
        ? [{ name: "Booking Fee", quantity: "1", catalogObjectId: BOOKING_FEE_CATALOG_ID }]
        : []),
    ];

    // ── Loyalty reward: create + redeem BEFORE payment ─────────────
    // If the customer selected a reward tier, create the reward (deducts
    // points immediately) and redeem it against the day-of order (applies
    // discount). The deposit sent to bowling-orders is already reduced by
    // the reward amount on the client side.
    let rewardFailReason: string | undefined;

    if (body.rewardDiscountCents && body.rewardDiscountCents > 0) {
      console.log(
        `[reserve] Reward requested: tierId=${body.rewardTierId} accountId=${body.loyaltyAccountId}` +
          ` orderId=${body.dayofOrderId} discount=${body.rewardDiscountCents}c token=${SQUARE_TOKEN ? "yes" : "NO"}`,
      );
    }
    if (body.rewardTierId && body.loyaltyAccountId && body.dayofOrderId && SQUARE_TOKEN) {
      try {
        // Create reward with order_id → ISSUED status, points deducted
        // immediately, reward attached to the day-of order. Do NOT call
        // /redeem — Square auto-redeems order-attached rewards at payment
        // time ("Cannot explicitly redeem rewards attached to an order").
        const createRes = await fetch(`${SQUARE_BASE}/loyalty/rewards`, {
          method: "POST",
          headers: sqLoyaltyHeaders(),
          body: JSON.stringify({
            reward: {
              loyalty_account_id: body.loyaltyAccountId,
              reward_tier_id: body.rewardTierId,
              order_id: body.dayofOrderId,
            },
            idempotency_key: `reward-${body.dayofOrderId}-${body.rewardTierId}`,
          }),
        });
        const createData = await createRes.json();
        if (createRes.ok && createData.reward?.id) {
          loyaltyRewardId = createData.reward.id;
          console.log(
            `[reserve] Loyalty reward created: ${loyaltyRewardId} (${rewardDiscountCents}c off)`,
          );
        } else {
          const err = createData.errors?.[0];
          console.error(`[reserve] Reward creation failed: ${err?.code}: ${err?.detail}`);
          rewardFailReason = `create_failed: ${createRes.status} ${err?.code}: ${err?.detail}`;
        }
      } catch (err) {
        console.error("[reserve] Loyalty reward error:", err);
        rewardFailReason = `exception: ${err instanceof Error ? err.message : String(err)}`;
        // Clean up if reward was created but threw afterwards
        if (loyaltyRewardId) {
          await fetch(`${SQUARE_BASE}/loyalty/rewards/${loyaltyRewardId}`, {
            method: "DELETE",
            headers: sqLoyaltyHeaders(),
          }).catch(() => {});
          loyaltyRewardId = undefined;
        }
      }
    } else if (rewardDiscountCents > 0) {
      // Condition was false — figure out which field is missing
      const missing = [
        !body.rewardTierId && "rewardTierId",
        !body.loyaltyAccountId && "loyaltyAccountId",
        !body.dayofOrderId && "dayofOrderId",
        !SQUARE_TOKEN && "SQUARE_TOKEN",
      ].filter(Boolean);
      rewardFailReason = `condition_false: missing ${missing.join(",")}`;
    }

    // ── Guard: reward discount requires a valid reward ───────────────
    // The client sends rewardDiscountCents and a reduced depositCents.
    // If the reward wasn't successfully created (Square API error, missing
    // fields, etc.) we MUST NOT honor the discount — it would give the
    // customer a free/reduced deposit without deducting loyalty points.
    if (rewardDiscountCents > 0 && !loyaltyRewardId) {
      console.error(
        `[reserve] Reward discount ${rewardDiscountCents}c requested but no reward created` +
          ` — failing booking. reason=${rewardFailReason}`,
      );
      // Clean up QAMF reservation
      try {
        const { deleteReservation } = await import("@/lib/qamf-bowling");
        await deleteReservation(centerId, qamfReservationId);
      } catch {
        // Non-fatal
      }
      return NextResponse.json(
        {
          error: "Your reward couldn't be applied right now. Please try again.",
          code: "REWARD_FAILED",
          // Surface the actual cause (Square rejection code/detail, or
          // "condition_false: missing <field>") so the failure is diagnosable
          // from the client without digging through server logs.
          reason: rewardFailReason,
        },
        { status: 422 },
      );
    }

    // ── Re-fetch order total after reward (authoritative price) ─────
    // When a reward is attached, Square recalculates the order total
    // (discount + tax adjustment). Re-fetch so the deposit is based on
    // the actual Square total, not the client's pre-reward estimate.
    let orderTotalAfterReward: number | undefined;
    if (loyaltyRewardId && body.dayofOrderId) {
      try {
        const orderRes = await fetch(`${SQUARE_BASE}/orders/${body.dayofOrderId}`, {
          headers: sqLoyaltyHeaders(),
        });
        if (orderRes.ok) {
          const orderData = await orderRes.json();
          orderTotalAfterReward = orderData.order?.total_money?.amount as number | undefined;
          console.log(
            `[reserve] Order total after reward: ${orderTotalAfterReward}c` +
              ` (was ${body.dayofTotalCents ?? "?"}c before reward)`,
          );
        }
      } catch {
        // Non-fatal — fall back to client-provided values
      }
    }

    // Use the reward-adjusted total from Square when available;
    // otherwise fall back to the client-provided day-of total.
    const authoritativeTotalCents =
      orderTotalAfterReward ?? body.dayofTotalCents ?? preTaxTotalCents;
    const actualDepositToCharge = loyaltyRewardId
      ? Math.round((authoritativeTotalCents * overallDepositPct) / 100)
      : (body.depositCents ?? Math.round((preTaxTotalCents * overallDepositPct) / 100));

    if (loyaltyRewardId) {
      console.log(
        `[reserve] Deposit calc: ${authoritativeTotalCents}c × ${overallDepositPct}% = ${actualDepositToCharge}c`,
      );
    }

    if (
      actualDepositToCharge > 0 &&
      (body.squareToken || body.giftCardNonce || body.externalPayment)
    ) {
      // ── Build day-of order (or reuse pre-created from quote) ────
      if (body.dayofOrderId) {
        squareDayofOrderId = body.dayofOrderId;
        totalCents = authoritativeTotalCents;

        // Attach loyalty customer if not set at quote time
        if (resolvedSquareCustomerId) {
          try {
            const getRes = await fetch(`${SQUARE_BASE}/orders/${squareDayofOrderId}`, {
              headers: sqLoyaltyHeaders(),
            });
            if (getRes.ok) {
              const getData = await getRes.json();
              if (!getData.order?.customer_id && getData.order?.version != null) {
                await fetch(`${SQUARE_BASE}/orders/${squareDayofOrderId}`, {
                  method: "PUT",
                  headers: sqLoyaltyHeaders(),
                  body: JSON.stringify({
                    order: {
                      location_id: squareLocationId,
                      customer_id: resolvedSquareCustomerId,
                      version: getData.order.version,
                    },
                  }),
                }).catch(() => {});
              }
            }
          } catch {
            // Non-fatal — customer linkage is for loyalty accrual
          }
        }

        // ── Attach Pizza Bowl food lines to the pre-created order ──────
        // The quote step pre-creates the day-of order with the package +
        // shoes only; the $0 Pizza Bowl pizza/soda selections (body.rawItems)
        // are collected afterward and were never re-attached here — so they
        // never fired to the kitchen KDS (the whole bug). Append them now.
        // Idempotent: skip if the order already carries the food item (e.g. a
        // retry, or a quote that already included it). $0 lines, so the
        // total/deposit computed at quote time is unaffected.
        if (body.rawItems?.length) {
          try {
            const getRes = await fetch(`${SQUARE_BASE}/orders/${squareDayofOrderId}`, {
              headers: sqLoyaltyHeaders(),
              cache: "no-store",
            });
            if (getRes.ok) {
              const order = (await getRes.json()).order;
              const existing = new Set<string>(
                (order?.line_items ?? [])
                  .map((li: { catalog_object_id?: string }) => li.catalog_object_id)
                  .filter((id: string | undefined): id is string => !!id),
              );
              const missing = body.rawItems.filter((ri) => !existing.has(ri.catalogObjectId));
              if (missing.length > 0 && order?.version != null) {
                const foodRes = await fetch(`${SQUARE_BASE}/orders/${squareDayofOrderId}`, {
                  method: "PUT",
                  headers: sqLoyaltyHeaders(),
                  body: JSON.stringify({
                    idempotency_key: `bowl-food-${squareDayofOrderId}`,
                    order: {
                      location_id: squareLocationId,
                      version: order.version,
                      line_items: missing.map((ri) => ({
                        catalog_object_id: ri.catalogObjectId,
                        quantity: String(ri.quantity),
                        ...(ri.modifiers?.length
                          ? {
                              applied_modifiers: ri.modifiers.map((m) => ({
                                catalog_object_id: m.catalog_object_id,
                              })),
                            }
                          : {}),
                        ...(ri.note ? { note: ri.note } : {}),
                      })),
                    },
                  }),
                });
                if (!foodRes.ok) {
                  const errBody = await foodRes.text().catch(() => "");
                  console.error(
                    `[bowling/v2/reserve] food-line attach failed order=${squareDayofOrderId}` +
                      ` status=${foodRes.status} ${errBody.slice(0, 200)}`,
                  );
                }
              }
            }
          } catch (err) {
            // Non-fatal — lane-open still settles the order; kitchen routing is
            // best-effort here (the reservation-status memo flags any miss).
            console.error(
              `[bowling/v2/reserve] food-line attach threw order=${squareDayofOrderId}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      } else {
        // Create day-of order from scratch (no quote step)
        const LOCATION_TAX: Record<string, string> = {
          TXBSQN0FEKQ11: "UBPQTR3W6ZKVRYFC7DXN2SJN",
          PPTR5G2N0QXF7: "BQNVIEEZQO2PX2FI72U6FEC4",
          // FastTrax (Lee County) — same county rate as HeadPinz FM.
          [FASTTRAX_CENTER_CODE]: FASTTRAX_TAX_CATALOG_ID,
        };
        const taxCatalogId = LOCATION_TAX[squareLocationId];
        const orderTaxes = taxCatalogId
          ? [{ uid: "location-sales-tax", catalog_object_id: taxCatalogId, scope: "ORDER" }]
          : [];

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dayofLineItems = sqLineItems.map((li: any) => {
          const modifiers = li.modifiers?.length
            ? {
                applied_modifiers: li.modifiers.map((m: { catalog_object_id: string }) => ({
                  catalog_object_id: m.catalog_object_id,
                })),
              }
            : {};
          const noteField = li.note ? { note: li.note } : {};
          if (li.catalogObjectId) {
            return {
              catalog_object_id: li.catalogObjectId,
              quantity: li.quantity,
              // Square honors base_price_money as a price-key OVERRIDE on
              // catalog-linked lines (catalog price is only a default) — it
              // MUST ride along or a promo-reduced line rings full catalog
              // price (the July-2026 USA250 incident). $0 pass-through lines
              // (pizza/soda) send amount 0 deliberately.
              ...(li.basePriceMoney ? { base_price_money: li.basePriceMoney } : {}),
              ...modifiers,
              ...noteField,
            };
          }
          return {
            name: li.name,
            quantity: li.quantity,
            base_price_money: li.basePriceMoney,
            ...modifiers,
            ...noteField,
          };
        });

        const dayofBaseKey = randomBytes(8).toString("hex");
        const dayofOrderRes = await fetch(`${SQUARE_BASE}/orders`, {
          method: "POST",
          headers: sqLoyaltyHeaders(),
          body: JSON.stringify({
            idempotency_key: `bowl-dayof-${dayofBaseKey}`,
            order: {
              location_id: squareLocationId,
              ...(resolvedSquareCustomerId ? { customer_id: resolvedSquareCustomerId } : {}),
              line_items: dayofLineItems,
              ...(orderTaxes.length > 0 ? { taxes: orderTaxes } : {}),
            },
          }),
        });
        const dayofOrderData = await dayofOrderRes.json();
        if (!dayofOrderRes.ok || dayofOrderData.errors) {
          const sqErr = dayofOrderData.errors?.[0];
          const detail = sqErr ? `${sqErr.code}: ${sqErr.detail}` : JSON.stringify(dayofOrderData);
          console.error("[bowling/v2/reserve] day-of order failed:", detail);
          return NextResponse.json({ error: `Failed to create order: ${detail}` }, { status: 500 });
        }
        squareDayofOrderId = dayofOrderData.order?.id as string;
        totalCents =
          (dayofOrderData.order?.total_money?.amount as number) ?? authoritativeTotalCents;
      }

      // Re-base the deposit on the TAX-INCLUSIVE day-of total now that the order
      // exists. The estimate above (actualDepositToCharge) used the PRE-TAX
      // subtotal whenever there was no quote (body.depositCents absent) — which
      // under-funds the gift card by county tax, so the lane-open charge is short
      // and Square rejects it ("The payment total does not match the order
      // total"). This notably hit KBF (adult-game / VIP extras are 100% deposit
      // but were funded pre-tax). The quote path already passes a tax-inclusive
      // body.depositCents, and the reward path already used the authoritative
      // total — both are left untouched. Matches the route's stated contract:
      // "deposit = depositPct% of the tax-inclusive day-of total."
      const chargeCents =
        !loyaltyRewardId && body.depositCents == null && totalCents > 0
          ? Math.round((totalCents * overallDepositPct) / 100)
          : actualDepositToCharge;

      // ── Charge deposit via shared deposit service ───────────────
      const ganPrefix = buildGanPrefix("WEB", squareLocationId);
      const ganSuffix = qamfReservationId.replace(/[^A-Za-z0-9]/g, "");
      const depositNote = `Deposit – ${qamfReservationId} – ${bookedAt.slice(0, 10).replace(/(\d{4})-(\d{2})-(\d{2})/, "$2/$3/$1")}`;

      if (body.externalPayment) {
        // ── KIOSK direct-Terminal: the reader ALREADY captured the card against
        // OUR prepared deposit order. Record it — NEVER re-charge (there is no
        // card token here). finalize recreates that exact order via the seed,
        // verifies the payment server-side (COMPLETED + right order + amount +
        // location), then funds the gift card. Idempotent, so a retry replays. ──
        const ep = body.externalPayment;
        // Game Zone cards riding the order: re-resolve the SAME lines prepare
        // used (idempotent re-derivation must byte-match) + read the anchor for
        // the ledger row pointers. Anchor lost with cards paid = fail loud.
        const gzFin =
          kioskGzCartEnabled() && body.gameCardPurchase
            ? resolveCartPurchase(body.gameCardPurchase)
            : null;
        const gzFinCents = gzFin?.totalCents ?? 0;
        // The prepare anchor is the source of truth for WHERE the paid order
        // lives. PREPARE takes the kiosk's own location (the paired reader can
        // only charge orders at ITS device's location — a FastTrax kiosk selling
        // HeadPinz bowling preps at LAB52…), while this full-reserve call falls
        // back to the QAMF centerCode (TXBSQN…). Re-deriving dep-order-${seed}
        // at the wrong location mints a DIFFERENT order and every finalize dies
        // with "terminal payment paid a different order" (2026-07-19, X159666:
        // two captures, zero bookings). Same story for the note — prepare's
        // order body must be re-sent byte-identical.
        const anchorRaw = await redis.get(`kiosk:terminal:anchor:${ep.seed}`).catch(() => null);
        const anchor =
          typeof anchorRaw === "string"
            ? (JSON.parse(anchorRaw) as {
                gameCards?: AnchorGameCards;
                locationId?: string;
              })
            : (anchorRaw as { gameCards?: AnchorGameCards; locationId?: string } | null);
        const depositLocationId = anchor?.locationId ?? squareLocationId;
        let gzAnchorCards: AnchorGameCards | null = null;
        if (gzFin) {
          gzAnchorCards = anchor?.gameCards ?? null;
          if (!gzAnchorCards) {
            console.error(
              `[bowling/v2/reserve] gz cards paid but anchor lost seed=${ep.seed} — refusing to finalize silently`,
            );
            return NextResponse.json(
              {
                error:
                  "We received your payment but couldn't find the card records — please see the front desk (do not pay again).",
                terminal: true,
              },
              { status: 500 },
            );
          }
        }
        // Displayed==charged tripwire: the amount the reader shows/charges is the
        // prepare deposit (+ cards); it must equal what reserve independently computes.
        if (ep.amountCents !== chargeCents + gzFinCents) {
          console.error(
            `[bowling/v2/reserve] terminal amount drift: reader ${ep.amountCents}c vs reserve ${chargeCents + gzFinCents}c — refusing to finalize`,
          );
        }
        try {
          depositBaseKey = ep.seed; // finalize recreates dep-order-${seed} = the paid order
          const depositResult = await finalizeDepositFromExternalPayment({
            baseKey: ep.seed,
            locationId: depositLocationId,
            amountCents: chargeCents, // server-authoritative; finalize verifies the reader paid EXACTLY this (+ card lines)
            ganPrefix,
            ganSuffix,
            // Byte-match prepare's order body (see anchor read above) — the
            // reservation-stamped depositNote belongs to the typed-card path.
            note: `Kiosk deposit ${ep.seed.slice(0, 12)}`,
            externalPaymentId: ep.paymentId,
            // Split checkout: every captured payment (gift card + tap) —
            // verification switches to sum-of-payments === order total.
            ...(ep.paymentIds && ep.paymentIds.length > 0
              ? { externalPaymentIds: ep.paymentIds }
              : {}),
            extraLines: gzFin?.orderLines,
            extraCents: gzFinCents,
          });
          squareDepositOrderId = depositResult.depositOrderId;
          squareDepositPaymentId = depositResult.depositPaymentId;
          squareGiftCardId = depositResult.giftCardId ?? undefined;
          squareGiftCardGan = depositResult.giftCardGan ?? undefined;
          depositCents = chargeCents;
          // Payment verified — mark the card rows charged (reloads also pending
          // for the bridge) + hand the fulfillment payload back to the kiosk.
          if (gzAnchorCards && gzFin) {
            for (const c of gzAnchorCards.cards) {
              await markCharged(c.txnId, depositResult.depositOrderId ?? "", {
                card: ep.paymentId,
              });
              if (gzAnchorCards.mode === "reload") {
                await markLoadState(c.txnId, "pending", "awaiting on-prem bridge load");
              }
            }
            gameCardsResult = {
              mode: gzAnchorCards.mode,
              groupId: gzAnchorCards.groupId,
              locationCode: gzAnchorCards.locationCode,
              cards: gzAnchorCards.cards.map((c) => {
                const resolved = gzFin.cards.find((r) => r.packageId === c.packageId);
                return {
                  txnId: c.txnId,
                  packageId: c.packageId,
                  accountNumber: c.accountNumber,
                  tokens: resolved?.pkg.tokens ?? 0,
                  bonusTokens: resolved?.pkg.bonusTokens ?? 0,
                };
              }),
            };
          }
        } catch (err) {
          // Money is ALREADY captured on the reader. Do NOT delete the QAMF
          // reservation and do NOT imply a re-charge. Stamp the paymentId on the
          // anchor (persist-first) so the terminal-orphan reconcile can complete
          // or refund, then surface a "see the front desk" message. The upsert
          // recreates the descriptive fields if Redis lost the prepare anchor;
          // the stamp merges the payment pointer (both are best-effort here).
          await upsertTerminalAnchor(ep.seed, {
            depositOrderId: ep.depositOrderId,
            depositCents: chargeCents,
            locationId: depositLocationId,
            baseKey: ep.seed,
            splitToken: randomUUID(),
            totalCents: chargeCents,
            source: "bowling",
          }).catch(() => {});
          await stampTerminalPaymentOnAnchor(ep.seed, ep.paymentId).catch(() => {});
          if (loyaltyRewardId) {
            await fetch(`${SQUARE_BASE}/loyalty/rewards/${loyaltyRewardId}`, {
              method: "DELETE",
              headers: sqLoyaltyHeaders(),
            }).catch(() => {});
            loyaltyRewardId = undefined;
          }
          const verifyFail =
            err instanceof TerminalPaymentUnverifiedError ||
            err instanceof TerminalAmountMismatchError;
          const msg = err instanceof Error ? err.message : "Payment verification failed";
          console.error("[bowling/v2/reserve] terminal finalize failed:", msg);
          return NextResponse.json(
            {
              error:
                "We received your payment but couldn't finish the booking — please see the front desk (do not pay again).",
              detail: msg,
              terminal: true,
            },
            { status: verifyFail ? 402 : 500 },
          );
        }
      } else {
        try {
          // Explicit baseKey (same shape createDepositAndCharge would generate)
          // so the card-vault capture below can derive its CreateCard key from
          // the deposit attempt's idempotency seed.
          depositBaseKey = randomBytes(8).toString("hex");
          const depositResult = await createDepositAndCharge({
            amountCents: chargeCents,
            locationId: squareLocationId,
            cardSourceId: body.squareToken,
            giftCardNonce: body.giftCardNonce,
            squareCustomerId: resolvedSquareCustomerId,
            ganPrefix,
            ganSuffix,
            note: depositNote,
            baseKey: depositBaseKey,
          });

          squareDepositOrderId = depositResult.depositOrderId;
          squareDepositPaymentId = depositResult.depositPaymentId;
          squareGiftCardId = depositResult.giftCardId ?? undefined;
          squareGiftCardGan = depositResult.giftCardGan ?? undefined;
          depositCents = chargeCents;
        } catch (err) {
          // Payment failed — delete loyalty reward to return points
          if (loyaltyRewardId) {
            await fetch(`${SQUARE_BASE}/loyalty/rewards/${loyaltyRewardId}`, {
              method: "DELETE",
              headers: sqLoyaltyHeaders(),
            }).catch(() => {});
            loyaltyRewardId = undefined;
          }
          // Best effort: delete the QAMF reservation to avoid orphan
          try {
            const { deleteReservation } = await import("@/lib/qamf-bowling");
            await deleteReservation(centerId, qamfReservationId);
          } catch {
            // Non-fatal
          }

          if (err instanceof DepositPaymentError) {
            return NextResponse.json(
              { error: err.friendlyMessage, code: err.code, detail: err.message },
              { status: 400 },
            );
          }
          const msg = err instanceof Error ? err.message : "Payment failed";
          console.error("[bowling/v2/reserve] deposit charge failed:", msg);
          return NextResponse.json({ error: msg }, { status: 500 });
        }
      }
    } else {
      // $0 deposit (reward covered it) or no token — day-of order from quote
      squareDayofOrderId = body.dayofOrderId;
      depositCents = 0;
      totalCents = authoritativeTotalCents;
    }
  }

  // NOTE: Loyalty point accrual happens at lane-open time (bowling-lane-open.ts),
  // NOT here — Square requires the order to be paid/completed before
  // AccumulateLoyaltyPoints will succeed, and the day-of order is still OPEN.

  // ── Persist to Neon ─────────────────────────────────────────────
  let neonId: number;
  try {
    // A paid booking where QAMF didn't confirm is stored as 'confirm_pending'
    // so the retry cron can pick it up.  Free bookings default to 'confirmed'
    // regardless — no money at stake and the lane is still held as Temporary.
    const neonStatus: "confirmed" | "confirm_pending" =
      depositCents > 0 && !qamfConfirmed ? "confirm_pending" : "confirmed";

    const row = await insertBowlingReservation(
      {
        centerCode,
        productKind,
        qamfReservationId,
        depositCents,
        totalCents,
        status: neonStatus,
        bookedAt,
        playerCount: players.length,
        guestName: guest.name,
        guestEmail: guest.email,
        guestPhone: guest.phone,
        notes,
        // In-center kiosk bookings get a distinct source (admin board badge).
        ...(body.bookingSource === "kiosk" ? { bookingSource: "kiosk" as const } : {}),
        squareDepositOrderId,
        squareDepositPaymentId,
        squareDayofOrderId,
        squareGiftCardId,
        squareGiftCardGan,
        squareCustomerId: resolvedSquareCustomerId,
        squareLoyaltyRewardId: loyaltyRewardId,
        rewardDiscountCents,
        // Price-key promo (e.g. USA250): code + the pre-tax cents it removed,
        // both server-derived above. The order-level discountCode mechanism
        // stamps these via UPDATE in its redemption block below instead (its
        // amount comes from the same evaluate step that logs the redemption).
        promoCode: promoRow && promoSavingsCents > 0 ? promoRow.code : undefined,
        promoSavingsCents: promoRow ? promoSavingsCents : 0,
        // Booked-pricing stamp (persist-first): HOW the primary line was
        // quantified, so the reservation-edit repricer never guesses. World
        // Cup VIP Bowling additionally persists WHICH match at capture so
        // ops/admin can tie the lane window to its fixture.
        ...(body.bookingMeta || wcFixture
          ? {
              bookingMetadata: {
                ...(body.bookingMeta
                  ? {
                      bowling: {
                        experienceSlug: body.experienceSlug ?? null,
                        laneCount: Math.max(1, Math.round(body.bookingMeta.laneCount ?? 1)),
                        durationMultiplier: body.bookingMeta.durationMultiplier ?? 1,
                        pricingMode:
                          productKind === "kbf"
                            ? "per_person"
                            : bowlingPricingMode({
                                hourly: body.kind === "hourly",
                                experienceSlug: body.experienceSlug,
                              }),
                      },
                    }
                  : {}),
                ...(wcFixture
                  ? {
                      worldCup: {
                        matchId: wcFixture.id,
                        round: wcFixture.round,
                        label: fixtureLabel(wcFixture),
                        kickoffEt: bookedAt,
                      },
                    }
                  : {}),
              },
            }
          : {}),
        loyaltyAction: body.loyaltyAction,
        attractionBookings: body.attractionBookings,
      },
      reservationLines,
    );
    neonId = row.id;

    // If QAMF confirmation failed on a paid booking, push to the Redis retry
    // queue so the bowling-confirm-retry cron can attempt again every 5 min.
    if (neonStatus === "confirm_pending") {
      const entry: ConfirmRetryEntry = {
        neonId,
        centerId,
        qamfReservationId,
        guestName: guest.name,
        guestEmail: guest.email,
        guestPhone: guest.phone,
        depositCents,
        queuedAt: new Date().toISOString(),
      };
      redis
        .lpush(CONFIRM_RETRY_QUEUE, JSON.stringify(entry))
        .catch((err) =>
          console.error("[bowling/v2/reserve] failed to push confirm-retry queue:", err),
        );
      console.warn(
        `[bowling/v2/reserve] neonId=${neonId} qamf=${qamfReservationId}` +
          ` depositCents=${depositCents} — QAMF not confirmed, queued for retry`,
      );
    }

    // Insert one player row per slot. For KBF: names + prefs pre-filled.
    // For open bowling: "Bowler N" placeholders — updated on confirmation page.
    try {
      // Assign players to lanes based on QAMF response
      function buildLaneAssignments(): (number | null)[] {
        if (qamfLanes.length === 0) return players.map(() => null);
        const perLane = Math.ceil(players.length / qamfLanes.length);
        return players.map((_, i) => {
          const idx = Math.min(Math.floor(i / perLane), qamfLanes.length - 1);
          return qamfLanes[idx].LaneNumber;
        });
      }
      const laneAssignments = buildLaneAssignments();

      await insertReservationPlayers(
        neonId,
        players.map((p, i) => ({
          slot: i + 1,
          name: p.name || null,
          shoeSize: p.shoeSize ?? null,
          bumpers: p.bumpers ?? null,
          kbfPassId: p.kbfPassId ?? null,
          kbfMemberSlot: p.kbfMemberSlot ?? null,
          kbfRelation: p.kbfRelation ?? null,
          laneNumber: laneAssignments[i] ?? null,
        })),
      );
    } catch (err) {
      // Non-fatal — player rows are convenience data
      console.error("[bowling/v2/reserve] insertReservationPlayers failed:", err);
    }

    // ── Shoe-size KDS items on the day-of Square order ──────────────
    // Kiosk (and KBF) rosters arrive here WITH shoe sizes, so the $0 shoe-KDS
    // lines must be pushed onto the day-of order now — the shoe desk reads that
    // order, and nothing else in this flow ever writes them. The web flow sends
    // placeholder rosters (no sizes) and syncs later via the confirmation-page
    // PATCH to /reservations/[id]/players, so this is a no-op for web.
    // Best-effort: the deposit is already captured and shoe KDS never gates a
    // booking (the helper swallows its own failures).
    if (squareDayofOrderId && players.some((p) => p.shoeSize)) {
      await syncShoeKdsLineItems({
        orderId: squareDayofOrderId,
        players: players.map((p) => ({ name: p.name, shoeSize: p.shoeSize })),
        idempotencyKey: `shoe-kds-${neonId}-${Date.now()}`,
        logLabel: "bowling/v2/reserve",
      });
    }

    // ── Discount-code redemption log ────────────────────────────────
    // The Square day-of order was created with the discount attached at the
    // quote step, so the customer is already paying the discounted amount.
    // We're just logging the redemption + bumping uses_count for reporting
    // and abuse caps.
    //
    // Failure modes are deliberately soft: if the code lost validity between
    // quote and reserve (e.g. ops deactivated it just now) we log a warning
    // but don't fail the booking — the discount is already locked into the
    // Square order. The counter being off by one is recoverable; refusing
    // to confirm a paid booking is not.
    if (body.discountCode) {
      try {
        const codeRow = await getDiscountCodeByCode(body.discountCode);
        const evald = evaluateCode(codeRow, {
          code: body.discountCode,
          domain: "bowling",
          locationId: centerCode,
          bookingDate: body.bookingDate,
        });
        if (!evald.valid) {
          console.warn(
            `[bowling/v2/reserve] discount code ${body.discountCode} drifted ` +
              `between quote and reserve: ${evald.reason}. Customer still received ` +
              `the Square discount; redemption not logged.`,
          );
        } else if (codeRow && squareDayofOrderId) {
          // external_ref is the day-of order id — the bowling-refund path
          // looks it up by the same ref to decrement uses_count on refund.
          const amountOff =
            evald.amountPct != null && totalCents > 0
              ? Math.round((totalCents * evald.amountPct) / 100)
              : (evald.amountCents ?? 0);
          const { alreadyRedeemed } = await recordRedemption({
            codeId: codeRow.id,
            domain: "bowling",
            externalRef: squareDayofOrderId,
            amountOffCents: amountOff,
            squareCustomerId: resolvedSquareCustomerId ?? null,
          });
          if (alreadyRedeemed) {
            console.log(
              `[bowling/v2/reserve] discount ${body.discountCode} already redeemed for order ${squareDayofOrderId} (idempotent retry)`,
            );
          } else {
            console.log(
              `[bowling/v2/reserve] discount ${body.discountCode} redeemed ` +
                `(neonId=${neonId} order=${squareDayofOrderId} off=$${(amountOff / 100).toFixed(2)})`,
            );
          }
          // Stamp the coupon onto the reservation row for the admin board.
          // (The price-key promo stamps at insert; this mechanism's amount is
          // only known here.) Best-effort, same soft-fail contract as above.
          if (neonId > 0) {
            await setBowlingReservationPromo(neonId, codeRow.code, amountOff);
          }
        }
      } catch (err) {
        console.error("[bowling/v2/reserve] redemption logging failed (non-fatal):", err);
      }
    }

    // ── USA250 price-key promo redemption log ───────────────────────
    // Same soft-fail contract as discountCode above. Previously bowling-only
    // carts never recorded price-key redemptions at all, so uses_count /
    // max_uses were unenforceable on this path and the ledger undercounted.
    // amountOff = the actual pre-tax per-line reduction applied, matching the
    // unified-reserve ledger convention. Keyed on the day-of order id —
    // idempotent on retry, and the refund path decrements by the same ref.
    if (promoRow && promoSavingsCents > 0 && squareDayofOrderId) {
      try {
        const { alreadyRedeemed } = await recordRedemption({
          codeId: promoRow.id,
          domain: "bowling",
          externalRef: squareDayofOrderId,
          amountOffCents: promoSavingsCents,
          squareCustomerId: resolvedSquareCustomerId ?? null,
        });
        console.log(
          `[bowling/v2/reserve] promo ${promoRow.code} ${
            alreadyRedeemed
              ? `already redeemed for order ${squareDayofOrderId} (idempotent retry)`
              : `redeemed (neonId=${neonId} order=${squareDayofOrderId} off=$${(promoSavingsCents / 100).toFixed(2)})`
          }`,
        );
      } catch (err) {
        console.error("[bowling/v2/reserve] promo redemption logging failed (non-fatal):", err);
      }
    }
  } catch (err) {
    console.error("[bowling/v2/reserve] Neon insert failed:", err);
    neonId = 0;
  }

  // ── Card-vault silent capture (plan §7 — NEVER fails the booking) ──
  // The reservation row exists; quietly keep the deposit card on file so
  // staff can charge approved edit differences later. captureCardFromDeposit
  // never throws by contract; the wrap is belt-and-braces.
  // Kiosk direct-Terminal is NEVER vaulted (owner: no saved card on a public
  // device; a card-present EMV payment has no reusable token anyway).
  if (
    squareDepositPaymentId &&
    resolvedSquareCustomerId &&
    depositBaseKey &&
    !body.externalPayment
  ) {
    try {
      await captureCardFromDeposit({
        squareCustomerId: resolvedSquareCustomerId,
        paymentId: squareDepositPaymentId,
        reservationId: neonId || null,
        depositOrderId: squareDepositOrderId ?? null,
        baseKey: depositBaseKey,
        sourceKind: body.sourceKind,
        permanentConsent: body.saveCardConsent === true,
      });
    } catch (err) {
      console.error("[bowling/v2/reserve] card-vault capture failed (non-fatal):", err);
    }
  }

  // ── Shorten confirmation URL ────────────────────────────────────
  // URL uses ?code= (the short code) so the sequential neonId never
  // appears in the browser bar. The confirmation page resolves the
  // code server-side via /api/bowling/v2/reservations/by-code/[code].
  // FastTrax duckpin confirms on the FastTrax domain (/book/bowling-confirmation)
  // so BrandNav + the short link stay on-brand; HeadPinz bowling/KBF stay on /hp.
  const confirmBase =
    centerId === FASTTRAX_QAMF_CENTER_ID
      ? "/book/bowling-confirmation"
      : productKind === "kbf"
        ? "/hp/book/kids-bowl-free/confirmation"
        : "/hp/book/bowling/confirmation";
  let shortCode: string | undefined;
  try {
    // Generate the code, then store the code-based destination URL
    shortCode = await shortenUrl(`${confirmBase}?code=_TMP_`);
    // Re-store with the real code baked into the destination
    await shortenUrl(`${confirmBase}?code=${shortCode}`, shortCode);
    // Persist to Neon for stable reuse (admin board, emails, SMS).
    // AWAIT this before returning: the confirmation page redirects the instant
    // this response lands and immediately resolves the booking via
    // /reservations/by-code/[code]. A fire-and-forget write here races that
    // redirect and 404s, surfacing a false "we couldn't save the detail record"
    // banner on a booking that saved perfectly. The write is a single indexed
    // UPDATE (~tens of ms) and stays non-fatal — the client also falls back to
    // the neonId we return below if the code mapping still isn't visible.
    if (neonId) {
      await updateBowlingReservationShortCode(neonId, shortCode).catch((err) =>
        console.error("[bowling/v2/reserve] failed to store short_code (non-fatal):", err),
      );
    }
  } catch (err) {
    // Non-fatal — wizard falls back to navigating with code param directly
    console.error("[bowling/v2/reserve] shortenUrl failed (non-fatal):", err);
  }

  // ── Final QAMF notes — tax-inclusive deposit + shoe status + short URL ──
  // The initial buildQamfNotes() ran before Square payment, so the deposit
  // amount was pre-tax and there was no short URL yet. Now that both are
  // available, patch the notes one more time with the authoritative version.
  try {
    const finalParts: string[] = [];

    // Shoe status + short URL — first line so staff see it at a glance.
    // FastTrax duckpin has no shoes: omit the shoe status entirely (a false
    // "SHOES NOT INCLUDED" would confuse duckpin staff) and brand the link.
    if (centerId === FASTTRAX_QAMF_CENTER_ID) {
      if (shortCode) finalParts.push(`fasttraxent.com/s/${shortCode}`);
    } else {
      const hasShoeAddOn = productItems.some(({ product }) => product.productKind === "addon_shoe");
      const shoesIncludedInExperience = reservationLines.some((l) =>
        /fun\s*4\s*all|pizza\s*bowl/i.test(l.label),
      );
      let shoeLine: string;
      if (hasShoeAddOn) {
        const shoeQty = productItems
          .filter(({ product }) => product.productKind === "addon_shoe")
          .reduce((s, { quantity }) => s + quantity, 0);
        shoeLine = `${shoeQty} pair${shoeQty !== 1 ? "s" : ""} shoes paid`;
      } else if (shoesIncludedInExperience) {
        shoeLine = "Shoes included";
      } else {
        shoeLine = "SHOES NOT INCLUDED";
      }
      if (shortCode) {
        shoeLine += ` | headpinz.com/s/${shortCode}`;
      }
      finalParts.push(shoeLine);
    }

    // KBF bowler breakdown — right after shoe/URL so staff see it immediately
    if (productKind === "kbf") {
      const kidCount = players.filter((p) => p.kbfRelation === "kid").length;
      const freeAdultCount = players.filter(
        (p) => !p.isPaidAdult && p.kbfRelation !== "kid",
      ).length;
      const breakdownParts: string[] = [];
      if (kidCount > 0) breakdownParts.push(`${kidCount} kid${kidCount !== 1 ? "s" : ""} free`);
      if (freeAdultCount > 0)
        breakdownParts.push(`${freeAdultCount} adult${freeAdultCount !== 1 ? "s" : ""} free (FBF)`);
      if (paidAdultCount > 0)
        breakdownParts.push(`${paidAdultCount} adult${paidAdultCount !== 1 ? "s" : ""} paid`);
      const vipTag = kbfIsVip ? " [VIP]" : "";
      finalParts.push(`KBF: ${breakdownParts.join(", ")}${vipTag}`);
    }

    // Line items summary
    if (reservationLines.length > 0) {
      const itemParts = reservationLines.map((l) => {
        const total = l.quantity * l.unitPriceCents;
        const totalStr = `$${(total / 100).toFixed(2)}`;
        return l.quantity > 1 ? `${l.quantity}x ${l.label} ${totalStr}` : `${l.label} ${totalStr}`;
      });
      finalParts.push(itemParts.join(" + "));
    }

    // Tax-inclusive deposit
    if (depositCents > 0) {
      finalParts.push(`Deposit $${(depositCents / 100).toFixed(2)} paid (incl. tax)`);
    }

    // Attraction add-ons
    if (body.attractionBookings && body.attractionBookings.length > 0) {
      const attrParts = body.attractionBookings.map(
        (a) => `${a.name} ${a.quantity}p @ ${a.timeLabel} ($${a.totalPriceDollars.toFixed(2)})`,
      );
      finalParts.push("Activities: " + attrParts.join(", "));
    }

    // User-supplied notes
    if (notes) finalParts.push(notes);

    // World Cup: lead the notes with the match + prefix the title so front
    // desk sees what this lane window is for (unified-reserve parity).
    if (wcFixture) finalParts.unshift(worldCupQamfBanner(wcFixture));

    const finalNotes = finalParts.join("\n");
    const finalTitle = wcFixture
      ? worldCupQamfTitle(guest.name, players.length)
      : `${guest.name} (${players.length}p)`;
    // Mirror the composed memo into OUR reservation notes FIRST (persist-first
    // rule) so the admin Notes tab shows what Conqueror got. finalNotes already
    // ends with the guest's own notes, so this supersedes the raw value saved
    // at insert.
    if (neonId) {
      updateBowlingReservationNotes(neonId, finalNotes).catch((err) =>
        console.warn("[bowling/v2/reserve] notes mirror failed (non-fatal):", err),
      );
    }
    patchReservation(centerId, qamfReservationId, { Title: finalTitle, Notes: finalNotes }).catch(
      (err) => console.warn("[bowling/v2/reserve] final notes patch failed (non-fatal):", err),
    );
  } catch (err) {
    console.warn("[bowling/v2/reserve] final notes build failed (non-fatal):", err);
  }

  const notifOrigin = req.nextUrl.origin;

  if (body.playNow && neonId && isFastTraxDuckpinCenter(centerId)) {
    // ── Play Now ("bowl now"): the guest is AT the lane. ──────────────
    // 1) Suppress the booking-confirmation email/SMS (no email for a walk-up
    //    QR booking — a mixed cart with attractions goes through
    //    unified-reserve, which keeps its confirmation).
    // 2) Suppress the lane-ready notification (mark it sent so the webhook/cron
    //    never fire "Your Lane is Ready!" — the lane's already turning on).
    // 3) Turn the lane on NOW, server-side, by calling the self-check-in route
    //    (Arrived → Ready → Running + settles the prepaid day-of order). Awaited
    //    so the lane is live before the guest reaches the confirmation screen —
    //    no "your lane is ready, tap to check in" step. Best-effort: if it
    //    hiccups, the confirmation page's poll self-opens as a fallback.
    markLaneReadySent(neonId).catch(() => {});
    try {
      const openRes = await fetch(`${notifOrigin}/api/bowling/v2/reservations/${neonId}/checkin`, {
        method: "POST",
      });
      if (!openRes.ok) {
        console.warn(
          `[bowling/v2/reserve] playNow lane-open HTTP ${openRes.status} neonId=${neonId} — confirmation will self-open`,
        );
      }
    } catch (err) {
      console.warn(
        `[bowling/v2/reserve] playNow lane-open failed neonId=${neonId} (confirmation self-opens):`,
        err,
      );
    }
  } else {
    // ── Fire confirmation email + SMS (server-side, non-blocking) ────
    // Triggered here instead of the client to avoid the browser aborting
    // the request during the post-booking redirect.
    fetch(`${notifOrigin}/api/notifications/bowling-confirmation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ neonId, smsOptIn: body.smsOptIn ?? true }),
    }).catch((err) => {
      console.error("[bowling/v2/reserve] notification fire-and-forget failed:", err);
    });
  }

  // World Cup: staff booking alert, Ultimate-VIP style (owner 7/6). Only
  // after everything above succeeded; best-effort inside.
  if (wcFixture) {
    await notifyWorldCupBooked({
      fixture: wcFixture,
      center: centerId,
      guestName: guest.name,
      guestEmail: guest.email,
      guestPhone: guest.phone,
      players: players.length,
      totalCents,
      qamfReservationId,
      squareDayofOrderId: squareDayofOrderId ?? null,
    });
  }

  return NextResponse.json({
    neonId,
    qamfReservationId,
    squareDepositOrderId,
    squareDepositPaymentId,
    squareDayofOrderId,
    squareGiftCardId,
    squareGiftCardGan,
    depositPaidCents: depositCents,
    totalCents,
    remainingCents: totalCents - depositCents,
    shortCode,
    confirmationPath: shortCode
      ? `${confirmBase}?code=${shortCode}`
      : `${confirmBase}?neonId=${neonId}`,
    // KIOSK: Game Zone cards charged with this booking — the confirmation
    // screen fulfills them (dispense/load or bridge reload).
    ...(gameCardsResult ? { gameCards: gameCardsResult } : {}),
  });
}
