import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createReservation, setReservationStatus } from "@/lib/qamf-bowling";
import {
  getBowlingSquareProduct,
  insertBowlingReservation,
  insertReservationPlayers,
  type BowlingSquareProduct,
  type ReservationLine,
} from "@/lib/bowling-db";

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
}

interface LineItemRequest {
  squareProductId: number;
  quantity: number;
}

interface ReserveBody {
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
  /** Square Web Payments SDK nonce. Required when any item has a charge. */
  squareToken?: string;
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
   * Booking flow kind — drives product_kind stored on the reservation row.
   * 'kbf' for Kids Bowl Free; 'open' for open / Fun 4 All bowling; 'hourly' for hourly rental.
   * Defaults to 'open' if omitted (backward-compatible).
   */
  kind?: "kbf" | "open" | "hourly";
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

  // Pre-tax subtotal (used to compute overallDepositPct + squareToken validation)
  const preTaxTotalCents = productItems.reduce(
    (s, { product, quantity }) => s + product.priceCents * quantity,
    0,
  );
  const preTaxDepositCents = productItems.reduce(
    (s, { product, quantity }) =>
      s + Math.round(product.priceCents * quantity * (product.depositPct / 100)),
    0,
  );

  // Weighted-average deposit % across all line items — passed to bowling-orders
  // so it can apply the same proportion to the tax-inclusive total.
  const overallDepositPct =
    preTaxTotalCents > 0
      ? Math.round((preTaxDepositCents / preTaxTotalCents) * 100)
      : 100;

  // Any items with a charge require a payment token
  const needsPayment = preTaxTotalCents > 0;
  if (needsPayment && !body.squareToken) {
    return NextResponse.json(
      { error: "squareToken required when deposit > 0" },
      { status: 400 },
    );
  }

  // ── Determine product kind ──────────────────────────────────────
  // Prefer the explicit kind from the request body. Fall back to inferring
  // from players (KBF players carry kbfPassId). Default to 'open'.
  const productKind: "kbf" | "open" =
    body.kind === "kbf" ? "kbf"
    : body.kind === "open" ? "open"
    : players.some((p) => p.kbfPassId) ? "kbf"
    : "open";

  // ── Create QAMF reservation ─────────────────────────────────────
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

  let qamfReservationId: string;
  try {
    const reservation = await createReservation(centerId, {
      BookedAt: bookedAt,
      Title: `${guest.name} (${players.length}p)`,
      Notes: notes,
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : "QAMF reservation failed";
    console.error("[bowling/v2/reserve] QAMF error:", msg);
    return NextResponse.json({ error: `Reservation failed: ${msg}` }, { status: 502 });
  }

  // ── Confirm QAMF reservation (moves from Temporary → Confirmed) ──
  // QAMF creates all reservations as Temporary; they won't appear in
  // Conqueror until we explicitly set status = Confirmed.
  try {
    await setReservationStatus(centerId, qamfReservationId, "Confirmed");
  } catch (err) {
    // Non-fatal for the booking itself — the slot is held even while Temporary.
    // Log so ops can identify and manually confirm if needed.
    console.error("[bowling/v2/reserve] setReservationStatus failed:", err);
  }

  // ── Square payment (gift card deposit + day-of order) ──────────
  let squareDepositPaymentId: string | undefined;
  let squareDayofOrderId: string | undefined;
  let squareGiftCardId: string | undefined;
  let squareGiftCardGan: string | undefined;
  let depositCents = 0;        // actual charged amount (tax-inclusive)
  let totalCents = 0;          // tax-inclusive day-of order total

  if (needsPayment) {
    const squareLocationId =
      body.locationId ?? centerCode;

    const sqLineItems = reservationLines.map((l) => {
      const product = productItems.find((p) => p.product.id === l.squareProductId)?.product;
      return {
        name: l.label,
        quantity: String(l.quantity),
        basePriceMoney: { amount: l.unitPriceCents, currency: "USD" as const },
        // Include catalog object ID so Square links to the catalog item for reporting
        ...(product?.squareCatalogObjectId
          ? { catalogObjectId: product.squareCatalogObjectId }
          : {}),
      };
    });

    const origin = req.nextUrl.origin;
    const sqRes = await fetch(`${origin}/api/square/bowling-orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceId: body.squareToken,
        idempotencyKey: randomUUID(),
        locationId: squareLocationId,
        depositPct: overallDepositPct,
        lineItems: sqLineItems,
        squareCustomerId: body.squareCustomerId,
        note: `Bowling – ${guest.name} – ${new Date(bookedAt).toLocaleDateString()}`,
        // Pass pre-created day-of order if provided (avoids duplicate creation).
        // Also forward the pre-computed deposit amount so bowling-orders uses
        // the exact figure shown to the customer rather than recalculating.
        ...(body.dayofOrderId ? {
          existingDayofOrderId: body.dayofOrderId,
          existingDayofTotalCents: body.dayofTotalCents,
          existingDepositCents: body.depositCents,
        } : {}),
      }),
    });

    const sqData = await sqRes.json();
    if (!sqRes.ok) {
      // Payment failed — best effort: delete the QAMF reservation to avoid orphan
      try {
        const { deleteReservation } = await import("@/lib/qamf-bowling");
        await deleteReservation(centerId, qamfReservationId);
      } catch {
        // Non-fatal
      }
      // Forward Square error code + detail so the client can show a specific message
      return NextResponse.json(
        {
          error: sqData.error ?? "Payment failed",
          code: sqData.code,
          detail: sqData.detail,
        },
        { status: sqRes.status },
      );
    }

    squareDepositPaymentId = sqData.depositPaymentId ?? undefined;
    squareDayofOrderId = sqData.dayofOrderId;
    squareGiftCardId = sqData.giftCardId ?? undefined;
    squareGiftCardGan = sqData.giftCardGan ?? undefined;
    depositCents = sqData.depositPaidCents ?? 0;
    totalCents = sqData.dayofTotalCents ?? preTaxTotalCents;
  }

  // ── Persist to Neon ─────────────────────────────────────────────
  let neonId: number;
  try {
    const row = await insertBowlingReservation(
      {
        centerCode,
        productKind,
        qamfReservationId,
        depositCents,
        totalCents,
        status: "confirmed",
        bookedAt,
        playerCount: players.length,
        guestName: guest.name,
        guestEmail: guest.email,
        guestPhone: guest.phone,
        notes,
        squareDepositPaymentId,
        squareDayofOrderId,
        squareGiftCardId,
        squareGiftCardGan,
      },
      reservationLines,
    );
    neonId = row.id;

    // Insert one player row per slot. For KBF: names + prefs pre-filled.
    // For open bowling: "Bowler N" placeholders — updated on confirmation page.
    try {
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
        })),
      );
    } catch (err) {
      // Non-fatal — player rows are convenience data
      console.error("[bowling/v2/reserve] insertReservationPlayers failed:", err);
    }
  } catch (err) {
    console.error("[bowling/v2/reserve] Neon insert failed:", err);
    neonId = 0;
  }

  return NextResponse.json({
    neonId,
    qamfReservationId,
    squareDepositPaymentId,
    squareDayofOrderId,
    squareGiftCardId,
    squareGiftCardGan,
    depositPaidCents: depositCents,
    totalCents,
    remainingCents: totalCents - depositCents,
    confirmationPath: `/hp/book/kids-bowl-free-v2/confirmation?neonId=${neonId}&qamfId=${qamfReservationId}&centerId=${centerId}`,
  });
}
