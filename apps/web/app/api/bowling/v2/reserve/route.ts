import { NextRequest, NextResponse } from "next/server";
import { randomUUID, randomBytes } from "crypto";
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
  updateBowlingReservationShortCode,
  type BowlingSquareProduct,
  type ReservationLine,
} from "@/lib/bowling-db";
import { setLanePlayers } from "@/lib/qamf-bowling";
import { toLaneInsertName } from "@/lib/qamf-name";
import redis from "@/lib/redis";
import { shortenUrl } from "@/lib/short-url";
import {
  normalizePhoneE164,
  recordOptIn,
  resolveAudienceMember,
  splitGuestName,
} from "~/features/marketing";
import { evaluateCode, getDiscountCodeByCode, recordRedemption } from "~/features/discount-codes";
import { createDepositAndCharge, DepositPaymentError } from "~/features/booking/service/deposit";

const CONFIRM_RETRY_QUEUE = "qamf:bowling:confirm-retry";

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
};

/** Short center prefix for deposit gift card GANs (e.g. HPFMX77012). */
const CENTER_GAN_PREFIX: Record<string, string> = {
  TXBSQN0FEKQ11: "HPFM",
  PPTR5G2N0QXF7: "HPN",
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
const ADULT_GAME_CATALOG_MON_THU = "55HD24QD6W2D5566EATRXIO4";
const ADULT_GAME_CATALOG_FRI = "PS37ALSQJQTTK7FSWFTROQ36";
const ADULT_GAME_VIP_CATALOG_MON_THU = "FN2JBP462OGS7ABTOL42VIK4";
const ADULT_GAME_VIP_CATALOG_FRI = "G67DSSE3MUARHUMMVP632Q6R";
const KBF_VIP_CATALOG = "VOTDI26ES5J7TCHDEZ24JNEN"; // Kids Bowl Free VIP (2)
const FBF_VIP_CATALOG = "KGFEKTF57JT5SE55JVVV2NEJ"; // Families Bowl Free VIP (2)
const KBF_GAMES_PER_SESSION = 2;

/** VIP lane upcharge: $1 per person per game for ALL bowlers (kids included). */
const KBF_VIP_PER_GAME_CENTS = 100;

const QAMF_CENTER_ID_TO_CODE: Record<number, string> = {
  9172: "TXBSQN0FEKQ11",
  3148: "PPTR5G2N0QXF7",
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
  /** QAMF center ID. Exactly one of centerId / centerCode must be provided. */
  centerId?: number;
  centerCode?: string;
  webOfferId: number;
  /** QAMF option ID (game/time/unlimited). */
  optionId?: number;
  optionType?: "Game" | "Time" | "Unlimited";
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
  squareCustomerId?: string;
  locationId?: string;
  notes?: string;
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

  const { webOfferId, bookedAt, players, guest, lineItems = [], notes } = body;
  const service = body.service ?? "BookForLater";

  if (!webOfferId || !bookedAt || !players?.length || !guest?.name) {
    return NextResponse.json(
      { error: "webOfferId, bookedAt, players, and guest are required" },
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

  // ── Load Square products + compute subtotals ────────────────────
  const productItems: { product: BowlingSquareProduct; quantity: number }[] = [];
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
    productItems.push({ product, quantity: li.quantity });
    reservationLines.push({
      squareProductId: product.id,
      label: product.label,
      quantity: li.quantity,
      unitPriceCents: product.priceCents,
    });
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
  const adultPerGameCents = isFriday ? (kbfIsVip ? 700 : 600) : kbfIsVip ? 600 : 500;
  const adultGameTotalCents = paidAdultCount * adultPerGameCents * KBF_GAMES_PER_SESSION;
  const adultGameCatalogId = kbfIsVip
    ? isFriday
      ? ADULT_GAME_VIP_CATALOG_FRI
      : ADULT_GAME_VIP_CATALOG_MON_THU
    : isFriday
      ? ADULT_GAME_CATALOG_FRI
      : ADULT_GAME_CATALOG_MON_THU;
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

  // Booking fee: $2.99, 100% deposit, catalog item 7VKAFU3HDPRSKY7ZB6CKXTRW
  const BOOKING_FEE_CENTS = 299;
  const BOOKING_FEE_CATALOG_ID = "7VKAFU3HDPRSKY7ZB6CKXTRW";
  const hasBookingFee = body.bookingFee === true;

  // Pre-tax subtotal (used to compute overallDepositPct + squareToken validation)
  const productTotal = productItems.reduce(
    (s, { product, quantity }) => s + product.priceCents * quantity,
    0,
  );
  // Adult game + VIP upcharge are 100% deposit (pay upfront, no day-of split).
  const kbfExtraCents = adultGameTotalCents + kbfVipUpchargeCents;
  const preTaxTotalCents = productTotal + kbfExtraCents + (hasBookingFee ? BOOKING_FEE_CENTS : 0);
  const productDeposit = productItems.reduce(
    (s, { product, quantity }) =>
      s + Math.round(product.priceCents * quantity * (product.depositPct / 100)),
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
  if (needsPayment && effectiveClientDeposit > 0 && !body.squareToken && !body.giftCardNonce) {
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
  let loyaltyRewardId: string | undefined;
  let rewardDiscountCents = body.rewardDiscountCents ?? 0;
  let depositCents = 0; // actual charged amount (tax-inclusive)
  let totalCents = 0; // tax-inclusive day-of order total

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
      // KBF paid adult game charges — catalog-linked for Square reporting
      ...(adultGameTotalCents > 0
        ? [
            {
              name: adultGameLabel,
              quantity: String(paidAdultCount * KBF_GAMES_PER_SESSION),
              basePriceMoney: { amount: adultPerGameCents, currency: "USD" as const },
              catalogObjectId: adultGameCatalogId,
            },
          ]
        : []),
      // KBF VIP upcharge for free bowlers — catalog-linked per bowler type
      ...(kbfIsVip
        ? (() => {
            const kbfKidCount = players.filter(
              (p) => !p.isPaidAdult && p.kbfRelation === "kid",
            ).length;
            const fbfAdultCount = players.filter((p) => !p.isPaidAdult).length - kbfKidCount;
            const items: Array<{
              name: string;
              quantity: string;
              basePriceMoney: { amount: number; currency: "USD" };
              catalogObjectId: string;
            }> = [];
            if (kbfKidCount > 0) {
              items.push({
                name: "Kids Bowl Free VIP",
                quantity: String(kbfKidCount),
                basePriceMoney: {
                  amount: KBF_VIP_PER_GAME_CENTS * KBF_GAMES_PER_SESSION,
                  currency: "USD",
                },
                catalogObjectId: KBF_VIP_CATALOG,
              });
            }
            if (fbfAdultCount > 0) {
              items.push({
                name: "Families Bowl Free VIP",
                quantity: String(fbfAdultCount),
                basePriceMoney: {
                  amount: KBF_VIP_PER_GAME_CENTS * KBF_GAMES_PER_SESSION,
                  currency: "USD",
                },
                catalogObjectId: FBF_VIP_CATALOG,
              });
            }
            return items;
          })()
        : []),
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

    if (actualDepositToCharge > 0 && (body.squareToken || body.giftCardNonce)) {
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
      } else {
        // Create day-of order from scratch (no quote step)
        const LOCATION_TAX: Record<string, string> = {
          TXBSQN0FEKQ11: "UBPQTR3W6ZKVRYFC7DXN2SJN",
          PPTR5G2N0QXF7: "BQNVIEEZQO2PX2FI72U6FEC4",
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

      // ── Charge deposit via shared deposit service ───────────────
      const ganPrefix = CENTER_GAN_PREFIX[centerCode] ?? "HP";
      const ganSuffix = qamfReservationId.replace(/[^A-Za-z0-9]/g, "");
      const depositNote = `Deposit – ${qamfReservationId} – ${bookedAt.slice(0, 10).replace(/(\d{4})-(\d{2})-(\d{2})/, "$2/$3/$1")}`;

      try {
        const depositResult = await createDepositAndCharge({
          amountCents: actualDepositToCharge,
          locationId: squareLocationId,
          cardSourceId: body.squareToken,
          giftCardNonce: body.giftCardNonce,
          squareCustomerId: resolvedSquareCustomerId,
          ganPrefix,
          ganSuffix,
          note: depositNote,
        });

        squareDepositOrderId = depositResult.depositOrderId;
        squareDepositPaymentId = depositResult.depositPaymentId;
        squareGiftCardId = depositResult.giftCardId;
        squareGiftCardGan = depositResult.giftCardGan;
        depositCents = actualDepositToCharge;
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
        squareDepositOrderId,
        squareDepositPaymentId,
        squareDayofOrderId,
        squareGiftCardId,
        squareGiftCardGan,
        squareCustomerId: resolvedSquareCustomerId,
        squareLoyaltyRewardId: loyaltyRewardId,
        rewardDiscountCents,
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
        }
      } catch (err) {
        console.error("[bowling/v2/reserve] redemption logging failed (non-fatal):", err);
      }
    }
  } catch (err) {
    console.error("[bowling/v2/reserve] Neon insert failed:", err);
    neonId = 0;
  }

  // ── Shorten confirmation URL ────────────────────────────────────
  // URL uses ?code= (the short code) so the sequential neonId never
  // appears in the browser bar. The confirmation page resolves the
  // code server-side via /api/bowling/v2/reservations/by-code/[code].
  const confirmBase =
    productKind === "kbf"
      ? "/hp/book/kids-bowl-free/confirmation"
      : "/hp/book/bowling/confirmation";
  let shortCode: string | undefined;
  try {
    // Generate the code, then store the code-based destination URL
    shortCode = await shortenUrl(`${confirmBase}?code=_TMP_`);
    // Re-store with the real code baked into the destination
    await shortenUrl(`${confirmBase}?code=${shortCode}`, shortCode);
    // Persist to Neon for stable reuse (admin board, emails, SMS)
    if (neonId) {
      updateBowlingReservationShortCode(neonId, shortCode).catch((err) =>
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

    // Shoe status + short URL — first line so staff see it at a glance
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

    const finalNotes = finalParts.join("\n");
    const finalTitle = `${guest.name} (${players.length}p)`;
    patchReservation(centerId, qamfReservationId, { Title: finalTitle, Notes: finalNotes }).catch(
      (err) => console.warn("[bowling/v2/reserve] final notes patch failed (non-fatal):", err),
    );
  } catch (err) {
    console.warn("[bowling/v2/reserve] final notes build failed (non-fatal):", err);
  }

  // ── Fire confirmation email + SMS (server-side, non-blocking) ────
  // Triggered here instead of the client to avoid the browser aborting
  // the request during the post-booking redirect.
  const notifOrigin = req.nextUrl.origin;
  fetch(`${notifOrigin}/api/notifications/bowling-confirmation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ neonId, smsOptIn: body.smsOptIn ?? true }),
  }).catch((err) => {
    console.error("[bowling/v2/reserve] notification fire-and-forget failed:", err);
  });

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
  });
}
