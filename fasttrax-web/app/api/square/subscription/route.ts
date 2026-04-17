import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

/**
 * Square Subscription creation endpoint.
 *
 * POST /api/square/subscription
 *
 * Flow:
 *   1. Find or create Square customer by phone (reuse pattern from /api/square/customer)
 *   2. Save the tokenized card to that customer -> POST /v2/cards
 *   3. Create subscription with planVariationId + startDate -> POST /v2/subscriptions
 *
 * No charge runs from this endpoint — Square bills on the start_date.
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

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "").replace(/^1/, "");
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

async function findOrCreateCustomer(params: {
  phone: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}): Promise<{ customerId: string; error?: string }> {
  const formattedPhone = normalizePhone(params.phone);

  const searchRes = await fetch(`${SQUARE_BASE}/customers/search`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      query: { filter: { phone_number: { exact: formattedPhone } } },
    }),
  });
  const searchData = await searchRes.json();

  if (searchData.customers && searchData.customers.length > 0) {
    const existing = searchData.customers[0];
    // Backfill missing name/email if we have new info
    const needsUpdate =
      (!existing.given_name && params.firstName) ||
      (!existing.family_name && params.lastName) ||
      (!existing.email_address && params.email);
    if (needsUpdate) {
      await fetch(`${SQUARE_BASE}/customers/${existing.id}`, {
        method: "PUT",
        headers: sqHeaders(),
        body: JSON.stringify({
          given_name: existing.given_name || params.firstName || undefined,
          family_name: existing.family_name || params.lastName || undefined,
          email_address: existing.email_address || params.email || undefined,
        }),
      }).catch(() => { /* best-effort */ });
    }
    return { customerId: existing.id };
  }

  const createRes = await fetch(`${SQUARE_BASE}/customers`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `cust-${formattedPhone}-${Date.now()}`,
      given_name: params.firstName || undefined,
      family_name: params.lastName || undefined,
      email_address: params.email || undefined,
      phone_number: formattedPhone,
    }),
  });
  const createData = await createRes.json();
  if (createData.customer?.id) return { customerId: createData.customer.id };
  console.error("[square/subscription] customer create failed:", createData);
  return { customerId: "", error: createData.errors?.[0]?.detail || "Customer create failed" };
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
      idempotency_key: `card-${params.customerId}-${Date.now()}`,
      source_id: params.cardToken,
      verification_token: params.verificationToken || undefined,
      card: { customer_id: params.customerId },
    }),
  });
  const data = await res.json();
  if (data.card?.id) return { cardId: data.card.id };
  console.error("[square/subscription] card save failed:", data);
  return { cardId: "", error: data.errors?.[0]?.detail || "Card save failed" };
}

async function createSubscription(params: {
  locationId: string;
  planVariationId: string;
  customerId: string;
  cardId: string;
  startDate: string; // YYYY-MM-DD
}): Promise<{ subscriptionId: string; status: string; error?: string }> {
  // Plan has `eligible_item_ids` set — Square uses that item's price with
  // RELATIVE pricing. No extra params needed on subscription create.
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
    }),
  });
  const data = await res.json();
  if (data.subscription?.id) {
    return { subscriptionId: data.subscription.id, status: data.subscription.status };
  }
  console.error("[square/subscription] subscription create failed:", data);
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
      locationId?: string;
      startDate?: string;
      phone?: string;
      firstName?: string;
      lastName?: string;
      email?: string;
    };

    if (!cardToken) return NextResponse.json({ error: "cardToken required" }, { status: 400 });
    if (!planVariationId) return NextResponse.json({ error: "planVariationId required" }, { status: 400 });
    if (!locationId) return NextResponse.json({ error: "locationId required" }, { status: 400 });
    if (!startDate) return NextResponse.json({ error: "startDate required" }, { status: 400 });
    if (!phone) return NextResponse.json({ error: "phone required" }, { status: 400 });

    // 1. Customer
    const cust = await findOrCreateCustomer({ phone, firstName, lastName, email });
    if (cust.error) return NextResponse.json({ error: cust.error }, { status: 500 });

    // 2. Save card
    const card = await saveCardToCustomer({
      customerId: cust.customerId,
      cardToken,
      verificationToken,
    });
    if (card.error) return NextResponse.json({ error: card.error, customerId: cust.customerId }, { status: 500 });

    // 3. Create subscription
    const sub = await createSubscription({
      locationId,
      planVariationId,
      customerId: cust.customerId,
      cardId: card.cardId,
      startDate,
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
