import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { authorizeMultiTender, SquarePaymentError } from "@/lib/square-gift-card";
import { addDeposit } from "@/lib/pandora-deposits";
import { enqueueDepositFailure } from "@/lib/bmi-deposit-retry";
import { insertBowlingReservation } from "@/lib/bowling-db";
import { logSale } from "@/lib/sales-log";
import redis from "@/lib/redis";
import {
  getPackVariant,
  packTotal,
  PACK_LOCATION_ID,
  PACK_TAX_CATALOG_ID,
} from "~/features/booking/data/race-packs";
import { FRIENDLY_PAYMENT_ERRORS } from "~/features/booking/service/deposit";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net";

function sqHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

function pandoraHeaders() {
  const key = process.env.SWAGGER_ADMIN_KEY || "";
  return {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

interface RequestBody {
  packId: string;
  personId?: string;
  newPerson?: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    dob?: string;
  };
  cardNonce?: string;
  savedCardId?: string;
  giftCardNonce?: string;
  squareCustomerId?: string;
  contact: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  };
  racerName?: string;
  loginCode?: string;
}

export async function POST(req: NextRequest) {
  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // ── 1. Validate ─────────────────────────────────────────────────────
  const pack = getPackVariant(body.packId);
  if (!pack) {
    return NextResponse.json({ error: `Unknown pack: ${body.packId}` }, { status: 400 });
  }
  if (!body.personId && !body.newPerson) {
    return NextResponse.json({ error: "personId or newPerson required" }, { status: 400 });
  }
  if (!body.cardNonce && !body.savedCardId && !body.giftCardNonce) {
    return NextResponse.json({ error: "Payment method required" }, { status: 400 });
  }
  if (!body.contact?.email || !body.contact?.firstName) {
    return NextResponse.json({ error: "Contact info required" }, { status: 400 });
  }

  const baseKey = randomBytes(8).toString("hex");

  // ── 2. Person resolution ────────────────────────────────────────────
  let personId = body.personId;
  let isNewRacer = !personId;

  if (!personId && body.newPerson) {
    try {
      const pandoraBody: Record<string, unknown> = {
        firstName: body.newPerson.firstName,
        lastName: body.newPerson.lastName,
      };
      if (body.newPerson.email) pandoraBody.email = body.newPerson.email;
      if (body.newPerson.phone) pandoraBody.phone = body.newPerson.phone;
      if (body.newPerson.dob) pandoraBody.birthdate = body.newPerson.dob;

      const res = await fetch(`${PANDORA_BASE}/v2/bmi/person`, {
        method: "POST",
        headers: pandoraHeaders(),
        body: JSON.stringify(pandoraBody),
        cache: "no-store",
      });
      const data = await res.json();
      personId = data.data?.personID || data.personId;
      if (!personId) {
        console.error("[purchase-pack] Pandora person create failed:", data);
        return NextResponse.json(
          { error: "Could not create racer account. Please try again or contact support." },
          { status: 400 },
        );
      }
      isNewRacer = true;
    } catch (err) {
      console.error("[purchase-pack] Pandora person create error:", err);
      return NextResponse.json(
        { error: "Could not create racer account. Please try again." },
        { status: 500 },
      );
    }
  }

  // ── 3. Build Square order ───────────────────────────────────────────
  const totalCents = Math.round(packTotal(pack.price) * 100);

  let orderId: string;
  let orderTotalCents: number;
  try {
    const orderRes = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `pack-order-${baseKey}`,
        order: {
          location_id: PACK_LOCATION_ID,
          reference_id: `pack-${pack.id}-${personId}`.slice(0, 40),
          line_items: [
            {
              catalog_object_id: pack.squareCatalogId,
              item_variation_name: pack.squareLineItemName,
              quantity: "1",
              base_price_money: {
                amount: Math.round(pack.price * 100),
                currency: "USD",
              },
            },
          ],
          taxes: [
            {
              catalog_object_id: PACK_TAX_CATALOG_ID,
              scope: "ORDER",
            },
          ],
        },
      }),
    });
    const orderData = await orderRes.json();
    if (!orderRes.ok || orderData.errors) {
      const sqErr = orderData.errors?.[0];
      const detail = sqErr ? `${sqErr.code}: ${sqErr.detail}` : JSON.stringify(orderData);
      console.error("[purchase-pack] Square order failed:", detail);
      return NextResponse.json({ error: `Failed to create order: ${detail}` }, { status: 500 });
    }
    orderId = orderData.order?.id;
    orderTotalCents = orderData.order?.total_money?.amount ?? totalCents;
    if (!orderId) {
      return NextResponse.json({ error: "Square order returned no ID" }, { status: 500 });
    }
  } catch (err) {
    console.error("[purchase-pack] Square order error:", err);
    return NextResponse.json({ error: "Failed to create order" }, { status: 500 });
  }

  // ── 4. Charge via multi-tender ──────────────────────────────────────
  let paymentId: string | undefined;
  let gcApprovedCents = 0;
  let cardApprovedCents = 0;
  try {
    const result = await authorizeMultiTender({
      orderId,
      locationId: PACK_LOCATION_ID,
      totalCents: orderTotalCents,
      baseKey,
      giftCardNonce: body.giftCardNonce,
      cardSourceId: body.cardNonce ?? body.savedCardId,
      customerId: body.squareCustomerId,
      note: `Race Pack: ${pack.squareLineItemName}`,
    });
    paymentId = result.cardPaymentId ?? result.gcPaymentId;
    gcApprovedCents = result.gcApprovedCents;
    cardApprovedCents = result.cardApprovedCents;
  } catch (err) {
    if (err instanceof SquarePaymentError) {
      const friendly =
        FRIENDLY_PAYMENT_ERRORS[err.code] ??
        err.message ??
        "Payment could not be processed. Please try again.";
      return NextResponse.json({ error: friendly, code: err.code }, { status: 400 });
    }
    console.error("[purchase-pack] payment error:", err);
    return NextResponse.json({ error: "Payment failed. Please try again." }, { status: 500 });
  }

  // ── 5. Credit via Pandora addDeposit ────────────────────────────────
  let depositId: string | undefined;
  let depositCreditPending = false;
  try {
    depositId = await addDeposit({
      personId: personId!,
      depositKindId: pack.depositKindId,
      amount: pack.raceCount,
    });
  } catch (err) {
    console.error("[purchase-pack] addDeposit failed:", err);
    depositCreditPending = true;
    try {
      await enqueueDepositFailure({
        source: "race-pack-v2",
        sourceRef: paymentId || orderId,
        locationId: PACK_LOCATION_ID,
        personId: personId!,
        depositKindId: pack.depositKindId,
        amount: pack.raceCount,
        initialError: err instanceof Error ? err.message : String(err),
      });
    } catch (enqErr) {
      console.error("[purchase-pack] enqueue failure row failed:", enqErr);
    }
  }

  // ── 6. Persist to Neon ──────────────────────────────────────────────
  let neonId: number | undefined;
  try {
    const neonRow = await insertBowlingReservation(
      {
        productKind: "race-pack",
        centerCode: "fm",
        status: "confirmed",
        bookedAt: new Date().toISOString(),
        bookingSource: "web",
        guestName: `${body.contact.firstName} ${body.contact.lastName}`,
        guestEmail: body.contact.email,
        guestPhone: body.contact.phone,
        depositCents: orderTotalCents,
        totalCents: orderTotalCents,
        squareDepositOrderId: orderId,
        squareDepositPaymentId: paymentId,
        bookingMetadata: {
          packId: pack.id,
          raceCount: pack.raceCount,
          type: pack.type,
          personId,
          depositKindId: pack.depositKindId,
          depositCreditPending,
        },
      },
      [],
    );
    neonId = neonRow?.id;
  } catch (err) {
    console.error("[purchase-pack] Neon insert failed (non-fatal):", err);
  }

  // ── 7. Log sale ─────────────────────────────────────────────────────
  try {
    await logSale({
      ts: new Date().toISOString(),
      billId: `pack-${orderId}`,
      brand: "fasttrax",
      location: "fortmyers",
      bookingType: "racing-pack",
      participantCount: 1,
      isNewRacer: isNewRacer,
      totalUsd: orderTotalCents / 100,
      email: body.contact.email,
      phone: body.contact.phone,
      raceProductNames: [pack.squareLineItemName],
      viaDeposit: true,
      depositId,
      depositCreditPending,
      depositPersonId: personId,
      depositKindId: pack.depositKindId,
      depositAmount: pack.raceCount,
    });
  } catch (err) {
    console.error("[purchase-pack] logSale failed (non-fatal):", err);
  }

  // ── 8. Store booking details in Redis ───────────────────────────────
  const syntheticBillId = `pack-${orderId}`;
  const bookingDetails = {
    billId: syntheticBillId,
    amount: (orderTotalCents / 100).toFixed(2),
    race: pack.squareLineItemName,
    name: body.racerName || `${body.contact.firstName} ${body.contact.lastName}`,
    email: body.contact.email,
    qty: String(pack.raceCount),
    isCreditOrder: "false",
    type: "race-pack",
    viaDeposit: "true",
    personId: String(personId),
    depositKindId: pack.depositKindId,
    raceCount: String(pack.raceCount),
    ...(body.loginCode ? { loginCode: body.loginCode } : {}),
  };
  try {
    await redis.set(`booking:${syntheticBillId}`, JSON.stringify(bookingDetails), "EX", 86400);
  } catch (err) {
    console.error("[purchase-pack] Redis store failed (non-fatal):", err);
  }

  // ── 9. Return ───────────────────────────────────────────────────────
  console.log(
    `[purchase-pack] success pack=${pack.id} person=${personId} order=${orderId} deposit=${depositId ?? "PENDING"}`,
  );

  return NextResponse.json({
    success: true,
    billId: syntheticBillId,
    orderId,
    paymentId,
    neonId,
    depositId,
    depositCreditPending,
    gcApprovedCents,
    cardApprovedCents,
  });
}
