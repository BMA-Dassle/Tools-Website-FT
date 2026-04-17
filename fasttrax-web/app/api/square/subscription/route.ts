import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

/**
 * Square Subscription creation.
 *
 * POST /api/square/subscription
 *
 * 1. Create Square customer (simple create — no search to avoid phone-filter
 *    edge cases; Square de-dupes by email internally)
 * 2. Save card to customer -> POST /v2/cards
 * 3. Create DRAFT order with the eligible item variation (required for
 *    RELATIVE-priced plans)
 * 4. Create subscription with phases referencing that order template
 *
 * No charge runs at signup — Square bills on start_date.
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders() {
  return {
    "Authorization": `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

async function createCustomer(params: {
  firstName?: string;
  lastName?: string;
  email?: string;
  /** Optional reference note — we store the user's phone in our own Redis record, not Square. */
  note?: string;
}): Promise<{ customerId: string; error?: string }> {
  // Intentionally NOT sending phone_number to Square — some user-entered phones
  // fail Square's "valid phone number" validator even when they pass our 10-digit
  // format check (fake/test numbers, invalid area codes). We keep the real phone
  // in our signup record + email. Square only needs email for subscription
  // billing reminders.
  const res = await fetch(`${SQUARE_BASE}/customers`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: randomUUID(),
      given_name: params.firstName || undefined,
      family_name: params.lastName || undefined,
      email_address: params.email || undefined,
      note: params.note || undefined,
    }),
  });
  const data = await res.json();
  if (data.customer?.id) return { customerId: data.customer.id };
  console.error("[square/subscription] customer create failed:", JSON.stringify(data));
  return { customerId: "", error: data.errors?.[0]?.detail || "Customer create failed" };
}

async function saveCardToCustomer(params: {
  customerId: string;
  cardToken: string;
  verificationToken?: string;
}): Promise<{ cardId: string; error?: string }> {
  const res = await fetch(`${SQUARE_BASE}/cards`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: randomUUID(),
      source_id: params.cardToken,
      verification_token: params.verificationToken || undefined,
      card: { customer_id: params.customerId },
    }),
  });
  const data = await res.json();
  if (data.card?.id) return { cardId: data.card.id };
  console.error("[square/subscription] card save failed:", JSON.stringify(data));
  return { cardId: "", error: data.errors?.[0]?.detail || "Card save failed" };
}

/** Lee County Sales Tax — 6.5%. HeadPinz Fort Myers sits in Lee County. */
const LEE_COUNTY_TAX_ID = "UBPQTR3W6ZKVRYFC7DXN2SJN";

async function createDraftOrder(params: {
  locationId: string;
  itemVariationId: string;
  customerId: string;
  /** Optional catalog Tax object ID to apply to the line item (e.g. Lee County) */
  taxCatalogId?: string;
}): Promise<{ orderId: string; error?: string }> {
  // Local UID so the line item can reference the tax entry on the order.
  const TAX_UID = "line-tax";
  const body: Record<string, unknown> = {
    idempotency_key: randomUUID(),
    order: {
      location_id: params.locationId,
      state: "DRAFT",
      customer_id: params.customerId,
      line_items: [
        {
          catalog_object_id: params.itemVariationId,
          quantity: "1",
          ...(params.taxCatalogId ? { applied_taxes: [{ tax_uid: TAX_UID }] } : {}),
        },
      ],
      ...(params.taxCatalogId
        ? {
            taxes: [
              {
                uid: TAX_UID,
                catalog_object_id: params.taxCatalogId,
                scope: "LINE_ITEM",
              },
            ],
          }
        : {}),
    },
  };
  const res = await fetch(`${SQUARE_BASE}/orders`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.order?.id) return { orderId: data.order.id };
  console.error("[square/subscription] draft order failed:", JSON.stringify(data));
  return { orderId: "", error: data.errors?.[0]?.detail || "Draft order failed" };
}

async function createSubscription(params: {
  locationId: string;
  planVariationId: string;
  customerId: string;
  cardId: string;
  startDate: string;
  orderTemplateId: string;
}): Promise<{ subscriptionId: string; status: string; error?: string }> {
  const res = await fetch(`${SQUARE_BASE}/subscriptions`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: randomUUID(),
      location_id: params.locationId,
      plan_variation_id: params.planVariationId,
      customer_id: params.customerId,
      card_id: params.cardId,
      start_date: params.startDate,
      timezone: "America/New_York",
      phases: [{ ordinal: 0, order_template_id: params.orderTemplateId }],
    }),
  });
  const data = await res.json();
  if (data.subscription?.id) {
    return { subscriptionId: data.subscription.id, status: data.subscription.status };
  }
  console.error("[square/subscription] subscription create failed:", JSON.stringify(data));
  return {
    subscriptionId: "",
    status: "",
    error: data.errors?.[0]?.detail || "Subscription create failed",
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      cardToken,
      verificationToken,
      planVariationId,
      itemVariationId,
      locationId,
      startDate,
      phone,
      firstName,
      lastName,
      email,
    } = body as {
      cardToken?: string;
      verificationToken?: string;
      planVariationId?: string;
      itemVariationId?: string;
      locationId?: string;
      startDate?: string;
      phone?: string;
      firstName?: string;
      lastName?: string;
      email?: string;
    };

    if (!cardToken) return NextResponse.json({ error: "cardToken required" }, { status: 400 });
    if (!planVariationId) return NextResponse.json({ error: "planVariationId required" }, { status: 400 });
    if (!itemVariationId) return NextResponse.json({ error: "itemVariationId required" }, { status: 400 });
    if (!locationId) return NextResponse.json({ error: "locationId required" }, { status: 400 });
    if (!startDate) return NextResponse.json({ error: "startDate required" }, { status: 400 });
    if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

    // 1. Customer (phone stored in our Redis signup record, not Square)
    const note = phone ? `Have-A-Ball signup. Phone: ${phone}` : "Have-A-Ball signup";
    const cust = await createCustomer({ firstName, lastName, email, note });
    if (cust.error) return NextResponse.json({ error: cust.error }, { status: 500 });

    // 2. Save card
    const card = await saveCardToCustomer({
      customerId: cust.customerId,
      cardToken,
      verificationToken,
    });
    if (card.error) {
      return NextResponse.json({ error: card.error, customerId: cust.customerId }, { status: 500 });
    }

    // 3. Draft order (required for RELATIVE-priced plans). Lee County tax
    //    auto-applied since HeadPinz Fort Myers is in Lee County.
    const draft = await createDraftOrder({
      locationId,
      itemVariationId,
      customerId: cust.customerId,
      taxCatalogId: LEE_COUNTY_TAX_ID,
    });
    if (draft.error) {
      return NextResponse.json(
        { error: `Draft order: ${draft.error}`, customerId: cust.customerId, cardId: card.cardId },
        { status: 500 },
      );
    }

    // 4. Subscription
    const sub = await createSubscription({
      locationId,
      planVariationId,
      customerId: cust.customerId,
      cardId: card.cardId,
      startDate,
      orderTemplateId: draft.orderId,
    });
    if (sub.error) {
      return NextResponse.json(
        { error: sub.error, customerId: cust.customerId, cardId: card.cardId },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      subscriptionId: sub.subscriptionId,
      status: sub.status,
      customerId: cust.customerId,
      cardId: card.cardId,
      startDate,
    });
  } catch (err) {
    console.error("[square/subscription] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Subscription error" },
      { status: 500 },
    );
  }
}
