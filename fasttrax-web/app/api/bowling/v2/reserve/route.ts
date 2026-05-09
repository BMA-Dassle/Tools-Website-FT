import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  createReservation,
  getReservation,
  setReservationStatus,
  setReservationCustomer,
  patchReservation,
} from "@/lib/qamf-bowling";
import {
  getBowlingSquareProduct,
  insertBowlingReservation,
  insertReservationPlayers,
  type BowlingSquareProduct,
  type ReservationLine,
} from "@/lib/bowling-db";
import redis from "@/lib/redis";
import { shortenUrl } from "@/lib/short-url";

const CONFIRM_RETRY_QUEUE = "qamf:bowling:confirm-retry";

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
  /**
   * Pre-created QAMF Temporary reservation ID from the hold-first flow.
   * When provided, we skip createReservation and instead update the guest
   * info + confirm the existing hold. If confirmation fails (hold expired),
   * we fall back to creating a fresh reservation.
   */
  qamfReservationId?: string;
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
  let qamfLanes: Array<{ LaneNumber: number }> = [];

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
        return l.quantity > 1
          ? `${l.quantity}x ${l.label} ${totalStr}`
          : `${l.label} ${totalStr}`;
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

  // ── Square payment (gift card deposit + day-of order) ──────────
  let squareDepositOrderId: string | undefined;
  let squareDepositPaymentId: string | undefined;
  let squareDayofOrderId: string | undefined;
  let squareGiftCardId: string | undefined;
  let squareGiftCardGan: string | undefined;
  let depositCents = 0;        // actual charged amount (tax-inclusive)
  let totalCents = 0;          // tax-inclusive day-of order total

  if (needsPayment) {
    const squareLocationId =
      body.locationId ?? centerCode;

    // Build Square line items, passing through catalog IDs, modifier selections, and notes.
    // lineItems (from the request body) carry modifier arrays keyed by squareProductId.
    const sqLineItems = [
      ...reservationLines.map((l) => {
        const product = productItems.find((p) => p.product.id === l.squareProductId)?.product;
        const reqItem  = lineItems.find((li) => li.squareProductId === l.squareProductId);
        return {
          name: l.label,
          quantity: String(l.quantity),
          basePriceMoney: { amount: l.unitPriceCents, currency: "USD" as const },
          // Include catalog object ID so Square links to the catalog item for reporting
          ...(product?.squareCatalogObjectId
            ? { catalogObjectId: product.squareCatalogObjectId }
            : {}),
          // Forward modifier selections (e.g. pizza topping, soda flavor) to Square
          ...(reqItem?.modifiers?.length
            ? { modifiers: reqItem.modifiers }
            : {}),
          // Forward free-text note (fallback when catalog modifiers not yet configured)
          ...(reqItem?.note ? { note: reqItem.note } : {}),
        };
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
    ];

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

    squareDepositOrderId  = sqData.depositOrderId  ?? undefined;
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
  } catch (err) {
    console.error("[bowling/v2/reserve] Neon insert failed:", err);
    neonId = 0;
  }

  // ── Shorten confirmation URL ────────────────────────────────────
  // Store only neonId — the confirmation page fetches everything else from Neon.
  const confirmBase =
    productKind === "kbf"
      ? "/hp/book/kids-bowl-free/confirmation"
      : "/hp/book/bowling/confirmation";
  let shortCode: string | undefined;
  try {
    shortCode = await shortenUrl(`${confirmBase}?neonId=${neonId}`);
  } catch (err) {
    // Non-fatal — wizard falls back to navigating with neonId param directly
    console.error("[bowling/v2/reserve] shortenUrl failed (non-fatal):", err);
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
    confirmationPath: `${confirmBase}?neonId=${neonId}`,
  });
}
