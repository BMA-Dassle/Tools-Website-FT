import { NextRequest, NextResponse } from "next/server";
import { randomUUID, randomBytes } from "crypto";
import { addDeposit } from "@/lib/pandora-deposits";
import { logSale } from "@/lib/sales-log";
import { enqueueDepositFailure } from "@/lib/bmi-deposit-retry";
import { authorizeMultiTender, SquarePaymentError } from "@/lib/square-gift-card";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_LOCATION_MAP: Record<string, string> = {
  fasttrax: "LAB52GY480CJF",
  headpinz: "TXBSQN0FEKQ11",
  naples: "PPTR5G2N0QXF7",
};
const SQUARE_VERSION = "2024-12-18";

function sqHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/**
 * Optional Square catalog reference for the order line item. When
 * `catalogObjectId` is provided we set it on the line + use the
 * caller-supplied `name` as `item_variation_name` so Square's
 * dashboard / receipts show the human-readable variant ("5-Race
 * Pack (Mon-Thu)") under the catalog product (race packs share one
 * catalog ID, distinguished only by name).
 */
interface LineItemSpec {
  /** Display name on the line. Falls back to "Booking" if unset. */
  name?: string;
  /** Square catalog item or variation id. */
  catalogObjectId?: string;
}

/**
 * Optional server-side action triggered AFTER Square payment
 * succeeds. Lets a caller wrap the payment + post-payment side
 * effect into a single atomic server-roundtrip so a tab close
 * between the two can't strand the customer (charged, but no
 * credit / no booking).
 *
 * With multi-tender support, this hook fires ONCE after BOTH
 * tenders settle — the customer gets their full credit regardless
 * of how the bill was split between gift card and card.
 */
interface PostPaymentAction {
  kind: "addDeposit";
  /** Pandora person id receiving the credit. */
  personId: string | number;
  /** DEPOSIT_KIND id (see lib/pandora-deposits.ts). */
  depositKindId: string;
  /** Number of credits to add (positive integer). */
  amount: number;
  /** Race-pack label for the sales-log row, e.g.
   *  "5-Race Pack (Mon-Thu)". */
  packLabel?: string;
  /** Number of races in the pack — flows into sales_log.pov_qty
   *  equivalent for credit packs (helpful for analytics). */
  raceCount?: number;
  /** True when the buyer is a brand-new racer (no Pandora person
   *  on file before this purchase). Optional — analytics nicety. */
  isNewRacer?: boolean;
}

/**
 * Process a payment using a tokenized card nonce or saved card ID
 * and/or a Square gift card nonce.
 *
 * POST body: {
 *   token?: string,             // From card.tokenize() — OR savedCardId, OR omitted (GC-only)
 *   useSavedCard?: boolean,
 *   savedCardId?: string,
 *   giftCardNonce?: string,     // From payments.giftCard().tokenize() — optional
 *   amount: number,             // Dollar amount (e.g. 49.99)
 *   billId: string,
 *   itemName: string,           // Line item description
 *   contact: { firstName, lastName, email, phone },
 *   saveCard?: boolean,
 *   squareCustomerId?: string,
 *   lineItem?: { name?, catalogObjectId? },
 *   postPaymentAction?: { kind: "addDeposit", ... },
 * }
 *
 * Multi-tender behavior:
 *   - GC alone: GC must cover the full amount or 400 is returned.
 *   - Card alone: card pays the full amount (unchanged behavior).
 *   - GC + card: GC authorizes up to its balance, card covers the
 *     remainder. If either auth fails, both are cancelled — no
 *     customer charge.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      token,
      useSavedCard,
      savedCardId,
      giftCardNonce,
      amount,
      billId,
      itemName,
      contact,
      saveCard,
      squareCustomerId,
      locationId,
      lineItem,
      postPaymentAction,
    } = body as {
      token?: string;
      useSavedCard?: boolean;
      savedCardId?: string;
      giftCardNonce?: string;
      amount?: number;
      billId?: string;
      itemName?: string;
      contact?: { firstName?: string; lastName?: string; email?: string; phone?: string };
      saveCard?: boolean;
      squareCustomerId?: string;
      locationId?: string;
      lineItem?: LineItemSpec;
      postPaymentAction?: PostPaymentAction;
    };

    const SQUARE_LOCATION = SQUARE_LOCATION_MAP[locationId || ""] || SQUARE_LOCATION_MAP.fasttrax;

    if (!amount || !billId) {
      return NextResponse.json({ error: "amount and billId required" }, { status: 400 });
    }

    const cardSourceId = useSavedCard && savedCardId ? savedCardId : token;
    if (!cardSourceId && !giftCardNonce) {
      return NextResponse.json(
        { error: "token, savedCardId, or giftCardNonce required" },
        { status: 400 },
      );
    }

    // 16-char hex baseKey leaves headroom for our longest
    // idempotency prefix (`cancel-card-` = 12) within Square's
    // 45-char limit: 12 + 1 + 16 = 29 < 45.
    const baseKey = randomBytes(8).toString("hex");
    const amountCents = Math.round(amount * 100);

    // ── Step 1: Create the Square order ───────────────────────────────
    //
    // When `lineItem.catalogObjectId` is provided we attach the
    // catalog ref + override the display name (race packs share one
    // catalog ID `YYOV5QCHQSJKZS7DDIALGU7Z` and distinguish variants
    // only via the override name). Pattern matches /api/square/checkout.
    const lineItemPayload: Record<string, unknown> = {
      quantity: "1",
      base_price_money: { amount: amountCents, currency: "USD" },
    };
    if (lineItem?.catalogObjectId) {
      lineItemPayload.catalog_object_id = lineItem.catalogObjectId;
      lineItemPayload.item_type = "ITEM";
      lineItemPayload.name = lineItem.name || itemName || "Booking";
    } else {
      lineItemPayload.name = lineItem?.name || itemName || "Deposit";
    }

    const orderRes = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `order-${baseKey}`,
        order: {
          location_id: SQUARE_LOCATION,
          line_items: [lineItemPayload],
        },
      }),
    });
    const orderData = await orderRes.json();

    if (!orderRes.ok || orderData.errors) {
      console.error("[square/pay] order creation failed:", orderData.errors || orderData);
      return NextResponse.json({ error: "Failed to create order" }, { status: 500 });
    }

    const squareOrderId = orderData.order?.id;

    // ── Step 2: Authorize tender(s) ───────────────────────────────────
    // authorizeMultiTender re-validates GAN (blocks internal deposit
    // cards), authorizes GC with accept_partial_authorization,
    // authorizes the card for the remainder, completes both, or cancels
    // everything on any failure. Never leaves a customer charged on throw.
    let multiTender;
    try {
      multiTender = await authorizeMultiTender({
        orderId: squareOrderId,
        locationId: SQUARE_LOCATION,
        totalCents: amountCents,
        baseKey,
        giftCardNonce,
        cardSourceId,
        customerId: squareCustomerId,
        buyerEmail: contact?.email,
        note: `FastTrax - ${itemName || "Booking"} | Ref: ${billId}`,
      });
    } catch (err) {
      if (err instanceof SquarePaymentError) {
        const messages: Record<string, string> = {
          INSUFFICIENT_FUNDS: "Card declined — insufficient funds. Try a different card.",
          GENERIC_DECLINE: "Card declined. Please try a different card.",
          INVALID_EXPIRATION: "Card expired. Please use a different card.",
          CVV_FAILURE: "CVV check failed. Please re-enter your card details.",
          CARD_EXPIRED: "Card expired. Please use a different card.",
          CARD_DECLINED: "Card declined. Please try a different card.",
          CARD_DECLINED_VERIFICATION_REQUIRED:
            "Additional verification required. Please try again.",
        };
        const userMessage = messages[err.code] || err.message;
        console.error(`[square/pay] tender failed: ${err.code} ${err.message}`);
        return NextResponse.json(
          { error: userMessage, code: err.code, detail: err.message },
          { status: 400 },
        );
      }
      throw err;
    }

    const { gcPaymentId, cardPaymentId, gcApprovedCents, cardApprovedCents, gcGan } = multiTender;

    // For back-compat with existing PaymentResult consumers: the
    // primary paymentId is the card payment when present, else the GC.
    const primaryPaymentId = cardPaymentId || gcPaymentId;

    // Fetch payment details for the card brand / last4 the UI shows
    // on the receipt screen. Only needed when a card actually ran.
    let cardBrand: string | null = null;
    let cardLast4: string | null = null;
    let receiptUrl: string | null = null;
    if (cardPaymentId) {
      try {
        const pRes = await fetch(`${SQUARE_BASE}/payments/${cardPaymentId}`, {
          headers: sqHeaders(),
        });
        if (pRes.ok) {
          const pData = await pRes.json();
          cardBrand = pData.payment?.card_details?.card?.card_brand ?? null;
          cardLast4 = pData.payment?.card_details?.card?.last_4 ?? null;
          receiptUrl = pData.payment?.receipt_url ?? null;
        }
      } catch {
        /* non-fatal — UI uses fallback */
      }
    } else if (gcPaymentId) {
      // GC-only — receipt url from the GC payment for completeness.
      try {
        const pRes = await fetch(`${SQUARE_BASE}/payments/${gcPaymentId}`, {
          headers: sqHeaders(),
        });
        if (pRes.ok) {
          const pData = await pRes.json();
          receiptUrl = pData.payment?.receipt_url ?? null;
        }
      } catch {
        /* non-fatal */
      }
    }

    // ── Step 3: Save card on file (if requested + customer exists) ────
    // Only runs when an actual card was used and the customer wanted
    // to save it. GC-only payments produce no saveable instrument.
    let savedNewCardId: string | null = null;
    if (saveCard && squareCustomerId && !useSavedCard && token && cardPaymentId) {
      try {
        const cardRes = await fetch(`${SQUARE_BASE}/cards`, {
          method: "POST",
          headers: sqHeaders(),
          body: JSON.stringify({
            idempotency_key: `card-${baseKey}`,
            source_id: token,
            card: {
              customer_id: squareCustomerId,
            },
          }),
        });
        const cardData = await cardRes.json();
        if (cardData.card) {
          savedNewCardId = cardData.card.id;
          console.log("[square/pay] card saved:", savedNewCardId);
        }
      } catch {
        console.warn("[square/pay] card save failed (non-fatal)");
      }
    }

    // ── Step 4: Post-payment action ──────────────────────────────────
    // Runs once after all tenders settle. With multi-tender,
    // `paymentId` no longer uniquely identifies the charge — we use
    // billId for the retry queue's sourceRef and stash both Square
    // paymentIds in notes for human auditability.
    let depositResult: { depositId?: string; failed?: boolean; error?: string } | null = null;
    if (postPaymentAction?.kind === "addDeposit") {
      const action = postPaymentAction;
      const packLabel = action.packLabel || itemName || "Race Pack";
      const tenderTrail =
        gcPaymentId && cardPaymentId
          ? `Multi-tender: gc=${gcPaymentId} card=${cardPaymentId}`
          : gcPaymentId
            ? `Single-tender gift card: gc=${gcPaymentId}`
            : `Single-tender card: card=${cardPaymentId}`;

      const salesLogBase = {
        ts: new Date().toISOString(),
        billId,
        brand:
          locationId === "headpinz" || locationId === "naples"
            ? ("headpinz" as const)
            : ("fasttrax" as const),
        location: locationId === "naples" ? ("naples" as const) : ("fortmyers" as const),
        bookingType: "racing-pack" as const,
        participantCount: 1,
        isNewRacer: action.isNewRacer ?? false,
        raceProductNames: [packLabel],
        totalUsd: amount,
        email: contact?.email,
        phone: contact?.phone?.replace?.(/\D/g, ""),
        viaDeposit: true,
        depositPersonId: String(action.personId),
        depositKindId: String(action.depositKindId),
        depositAmount: action.amount,
      };

      try {
        const depositId = await addDeposit({
          personId: action.personId,
          depositKindId: action.depositKindId,
          amount: action.amount,
        });
        await logSale({ ...salesLogBase, depositId, depositCreditPending: false });
        depositResult = { depositId };
        console.log(
          `[square/pay] deposit credited: billId=${billId} personId=${action.personId} kind=${action.depositKindId} amount=${action.amount} depositId=${depositId}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "addDeposit failed";
        await logSale({ ...salesLogBase, depositCreditPending: true });
        await enqueueDepositFailure({
          source: "race-pack-square",
          sourceRef: billId || randomUUID(),
          locationId: "LAB52GY480CJF",
          personId: String(action.personId),
          depositKindId: String(action.depositKindId),
          amount: action.amount,
          initialError: msg,
          notes: `Pack: ${packLabel}. Charge: $${amount}. ${tenderTrail}.`,
        });
        depositResult = { failed: true, error: msg };
        console.error(
          `[square/pay] addDeposit FAILED after Square charge: billId=${billId} personId=${action.personId} kind=${action.depositKindId} amount=${action.amount} err=${msg}`,
        );
      }
    }

    console.log(
      `[square/pay] success billId=${billId} amount=${amount} gc=${gcApprovedCents} card=${cardApprovedCents} gcPaymentId=${gcPaymentId ?? "-"} cardPaymentId=${cardPaymentId ?? "-"}`,
    );

    return NextResponse.json({
      success: true,
      paymentId: primaryPaymentId,
      orderId: squareOrderId,
      receiptUrl,
      cardBrand,
      cardLast4,
      amount,
      savedCardId: savedNewCardId,
      // Multi-tender breakdown for UI display.
      giftCardAppliedCents: gcApprovedCents,
      giftCardLast4: gcGan ? gcGan.slice(-4) : null,
      paymentIds: { gc: gcPaymentId ?? null, card: cardPaymentId ?? null },
      // Post-payment hook fields (race packs).
      depositId: depositResult?.depositId,
      depositCreditFailed: depositResult?.failed === true ? true : undefined,
      depositError: depositResult?.error,
    });
  } catch (err) {
    console.error("[square/pay] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Payment error" },
      { status: 500 },
    );
  }
}
