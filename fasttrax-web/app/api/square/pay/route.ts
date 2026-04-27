import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { addDeposit } from "@/lib/pandora-deposits";
import { logSale } from "@/lib/sales-log";

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
    "Authorization": `Bearer ${SQUARE_TOKEN}`,
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
 * Currently only `addDeposit` — used by the race-packs Square +
 * Pandora-deposit workaround. If addDeposit fails after Square
 * charged, we still write the sales-log row (flagged
 * `depositCreditPending: true`) and return success on payment but
 * `depositCreditFailed: true` in the response so the UI can surface
 * "charged but credit pending" to the customer + admin can retry.
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
 * Process a payment using a tokenized card nonce or saved card ID.
 *
 * POST body: {
 *   token: string,           // From card.tokenize() — OR savedCardId
 *   useSavedCard: boolean,
 *   savedCardId?: string,
 *   amount: number,          // Dollar amount (e.g. 49.99)
 *   billId: string,
 *   itemName: string,        // Line item description
 *   contact: { firstName, lastName, email, phone },
 *   saveCard: boolean,
 *   squareCustomerId?: string,
 *   lineItem?: { name?, catalogObjectId? },  // Optional Square catalog reference
 *   postPaymentAction?: { kind: "addDeposit", ... },  // Optional server-side hook
 * }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      token,
      useSavedCard,
      savedCardId,
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

    const sourceId = useSavedCard && savedCardId ? savedCardId : token;
    if (!sourceId) {
      return NextResponse.json({ error: "token or savedCardId required" }, { status: 400 });
    }

    const idempotencyKey = randomUUID();
    const amountCents = Math.round(amount * 100);

    // Step 1: Create Square order
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
        idempotency_key: `order-${idempotencyKey}`,
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

    // Step 2: Process payment
    const paymentBody: Record<string, unknown> = {
      source_id: sourceId,
      idempotency_key: idempotencyKey,
      amount_money: { amount: amountCents, currency: "USD" },
      order_id: squareOrderId,
      location_id: SQUARE_LOCATION,
      autocomplete: true,
      note: `FastTrax - ${itemName || "Booking"} | Ref: ${billId}`,
    };

    if (contact?.email) paymentBody.buyer_email_address = contact.email;
    if (squareCustomerId) paymentBody.customer_id = squareCustomerId;

    const payRes = await fetch(`${SQUARE_BASE}/payments`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify(paymentBody),
    });
    const payData = await payRes.json();

    if (!payRes.ok || payData.errors) {
      const sqError = payData.errors?.[0];
      const code = sqError?.code || "UNKNOWN";
      const detail = sqError?.detail || "Payment failed";
      console.error("[square/pay] payment failed:", code, detail);

      // Map Square error codes to user-friendly messages
      const messages: Record<string, string> = {
        INSUFFICIENT_FUNDS: "Card declined — insufficient funds. Try a different card.",
        GENERIC_DECLINE: "Card declined. Please try a different card.",
        INVALID_EXPIRATION: "Card expired. Please use a different card.",
        CVV_FAILURE: "CVV check failed. Please re-enter your card details.",
        CARD_EXPIRED: "Card expired. Please use a different card.",
        CARD_DECLINED: "Card declined. Please try a different card.",
        CARD_DECLINED_VERIFICATION_REQUIRED: "Additional verification required. Please try again.",
      };

      return NextResponse.json({
        error: messages[code] || "Payment could not be processed. Please try again.",
        code,
        detail,
      }, { status: 400 });
    }

    const payment = payData.payment;
    const cardDetails = payment?.card_details;

    // Step 3: Save card on file (if requested + customer exists)
    let savedNewCardId: string | null = null;
    if (saveCard && squareCustomerId && !useSavedCard && token) {
      try {
        const cardRes = await fetch(`${SQUARE_BASE}/cards`, {
          method: "POST",
          headers: sqHeaders(),
          body: JSON.stringify({
            idempotency_key: `card-${idempotencyKey}`,
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

    // Step 4: Post-payment action (currently: addDeposit for the
    // race-packs Square+Pandora workaround). Runs server-side so a
    // tab close between charge + credit can't leave the customer
    // stranded — every code path here writes a sales-log row, so
    // admin always sees the charge regardless of credit outcome.
    let depositResult: { depositId?: string; failed?: boolean; error?: string } | null = null;
    if (postPaymentAction?.kind === "addDeposit") {
      const action = postPaymentAction;
      const packLabel = action.packLabel || itemName || "Race Pack";

      // Common sales-log fields (filled in below per outcome). The
      // sales board indexes on `via_deposit` + `deposit_credit_pending`
      // so admin can audit / retry from one place.
      const salesLogBase = {
        ts: new Date().toISOString(),
        billId,
        brand: locationId === "headpinz" || locationId === "naples" ? "headpinz" as const : "fasttrax" as const,
        location: locationId === "naples" ? "naples" as const : "fortmyers" as const,
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
        console.log(`[square/pay] deposit credited: billId=${billId} personId=${action.personId} kind=${action.depositKindId} amount=${action.amount} depositId=${depositId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "addDeposit failed";
        // Square already charged — write a pending row so admin can
        // reconcile from the sales board. Do NOT surface this as a
        // payment error to the customer — they paid, we just need
        // the credit to land separately.
        await logSale({ ...salesLogBase, depositCreditPending: true });
        depositResult = { failed: true, error: msg };
        console.error(`[square/pay] addDeposit FAILED after Square charge: billId=${billId} personId=${action.personId} kind=${action.depositKindId} amount=${action.amount} err=${msg}`);
      }
    }

    return NextResponse.json({
      success: true,
      paymentId: payment?.id,
      orderId: squareOrderId,
      receiptUrl: payment?.receipt_url || null,
      cardBrand: cardDetails?.card?.card_brand || null,
      cardLast4: cardDetails?.card?.last_4 || null,
      amount,
      savedCardId: savedNewCardId,
      // Only present when postPaymentAction ran. UI uses this to
      // show "credits added" vs. "charged but credit pending".
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
