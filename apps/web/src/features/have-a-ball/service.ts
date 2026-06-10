import { randomUUID } from "crypto";
import redis from "@/lib/redis";
import {
  computeJoinPlan,
  habMinusOneDay,
  habTodayYmd,
  HAB_ITEM_VARIATION_ID,
  HAB_LEE_COUNTY_TAX_ID,
  HAB_LOCATION_ID,
  HAB_PLAN_VARIATION_ID,
  type JoinPlan,
} from "./schedule";
import { sendHabConfirmationEmail } from "./email";

/**
 * Have-A-Ball mid-season join orchestration.
 *
 * One atomic flow replacing the old 3-call modal sequence:
 *   1. Create Square customer (email-only — phone kept in our record)
 *   2. Save the card on file
 *   3. Recompute the join plan SERVER-SIDE (never trust client amounts)
 *   4. Back-pay: charge the saved card once for weeks already played
 *      (real catalog order + Lee County tax, so it itemizes correctly)
 *   5. Subscription: create it starting the next Tuesday, capped via
 *      canceled_date so it stops after the final season charge
 *   6. Persist the signup record + send the confirmation email
 *
 * Money rule (CLAUDE.md): the displayed quote and the charge derive from the
 * SAME computeJoinPlan() — and we recompute here at charge time rather than
 * trusting whatever the browser showed.
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";
const SIGNUP_TTL = 60 * 60 * 24 * 365; // 1 year
const SIGNUP_INDEX_KEY = "league:haveaball:all";

function sqHeaders() {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN || ""}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

export interface HabJoinInput {
  cardToken: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dob: string;
  teamName?: string | null;
  smsOptIn?: boolean;
  /** Client-generated id so a network retry can't double-charge the back-pay. */
  joinAttemptId: string;
}

export interface HabJoinResult {
  ok: true;
  subscriptionId: string;
  customerId: string;
  cardId: string;
  backPayPaymentId: string | null;
  plan: JoinPlan;
}

async function createCustomer(p: {
  firstName: string;
  lastName: string;
  email: string;
  note: string;
}): Promise<{ customerId: string; error?: string }> {
  // Intentionally NOT sending phone to Square — some user-entered phones fail
  // Square's validator. Real phone lives in our Redis record + email.
  const res = await fetch(`${SQUARE_BASE}/customers`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: randomUUID(),
      given_name: p.firstName || undefined,
      family_name: p.lastName || undefined,
      email_address: p.email || undefined,
      note: p.note || undefined,
    }),
  });
  const data = await res.json();
  if (data.customer?.id) return { customerId: data.customer.id };
  console.error("[hab/join] customer create failed:", JSON.stringify(data));
  return { customerId: "", error: data.errors?.[0]?.detail || "Customer create failed" };
}

async function saveCard(p: {
  customerId: string;
  cardToken: string;
}): Promise<{ cardId: string; error?: string }> {
  const res = await fetch(`${SQUARE_BASE}/cards`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: randomUUID(),
      source_id: p.cardToken,
      card: { customer_id: p.customerId },
    }),
  });
  const data = await res.json();
  if (data.card?.id) return { cardId: data.card.id };
  console.error("[hab/join] card save failed:", JSON.stringify(data));
  return { cardId: "", error: data.errors?.[0]?.detail || "Card save failed" };
}

/** Build an order with N × Have-A-Ball item + Lee County tax. Used for back-pay. */
async function createBackPayOrder(p: {
  customerId: string;
  weeks: number;
}): Promise<{ orderId: string; totalCents: number; error?: string }> {
  const TAX_UID = "line-tax";
  const res = await fetch(`${SQUARE_BASE}/orders`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: randomUUID(),
      order: {
        location_id: HAB_LOCATION_ID,
        state: "OPEN",
        customer_id: p.customerId,
        reference_id: "hab-backpay",
        line_items: [
          {
            catalog_object_id: HAB_ITEM_VARIATION_ID,
            quantity: String(p.weeks),
            applied_taxes: [{ tax_uid: TAX_UID }],
          },
        ],
        taxes: [{ uid: TAX_UID, catalog_object_id: HAB_LEE_COUNTY_TAX_ID, scope: "LINE_ITEM" }],
      },
    }),
  });
  const data = await res.json();
  if (data.order?.id) {
    return { orderId: data.order.id, totalCents: data.order.total_money?.amount ?? 0 };
  }
  console.error("[hab/join] back-pay order failed:", JSON.stringify(data));
  return { orderId: "", totalCents: 0, error: data.errors?.[0]?.detail || "Back-pay order failed" };
}

/** Charge the saved card on file for the back-pay order total. */
async function chargeBackPay(p: {
  customerId: string;
  cardId: string;
  orderId: string;
  amountCents: number;
  idempotencyKey: string;
}): Promise<{ paymentId: string; error?: string }> {
  const res = await fetch(`${SQUARE_BASE}/payments`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: p.idempotencyKey,
      source_id: p.cardId,
      customer_id: p.customerId,
      location_id: HAB_LOCATION_ID,
      order_id: p.orderId,
      amount_money: { amount: p.amountCents, currency: "USD" },
      autocomplete: true,
      note: "Have-A-Ball mid-season back-pay (weeks already played)",
    }),
  });
  const data = await res.json();
  if (data.payment?.id) return { paymentId: data.payment.id };
  console.error("[hab/join] back-pay charge failed:", JSON.stringify(data));
  return { paymentId: "", error: data.errors?.[0]?.detail || "Back-pay charge failed" };
}

/** Draft order used as the subscription's recurring billing template. */
async function createSubTemplate(customerId: string): Promise<{ orderId: string; error?: string }> {
  const TAX_UID = "line-tax";
  const res = await fetch(`${SQUARE_BASE}/orders`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: randomUUID(),
      order: {
        location_id: HAB_LOCATION_ID,
        state: "DRAFT",
        customer_id: customerId,
        line_items: [
          {
            catalog_object_id: HAB_ITEM_VARIATION_ID,
            quantity: "1",
            applied_taxes: [{ tax_uid: TAX_UID }],
          },
        ],
        taxes: [{ uid: TAX_UID, catalog_object_id: HAB_LEE_COUNTY_TAX_ID, scope: "LINE_ITEM" }],
      },
    }),
  });
  const data = await res.json();
  if (data.order?.id) return { orderId: data.order.id };
  console.error("[hab/join] sub template order failed:", JSON.stringify(data));
  return { orderId: "", error: data.errors?.[0]?.detail || "Subscription template failed" };
}

async function createSubscription(p: {
  customerId: string;
  cardId: string;
  startDate: string;
  canceledDate: string;
  orderTemplateId: string;
}): Promise<{ subscriptionId: string; status: string; error?: string }> {
  const res = await fetch(`${SQUARE_BASE}/subscriptions`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: randomUUID(),
      location_id: HAB_LOCATION_ID,
      plan_variation_id: HAB_PLAN_VARIATION_ID,
      customer_id: p.customerId,
      card_id: p.cardId,
      // Square stores an explicit future start_date/canceled_date as +1 day, so
      // we send (intended − 1) to land on the intended day. See habMinusOneDay.
      start_date: habMinusOneDay(p.startDate),
      canceled_date: habMinusOneDay(p.canceledDate),
      timezone: "America/New_York",
      phases: [{ ordinal: 0, order_template_id: p.orderTemplateId }],
    }),
  });
  const data = await res.json();
  if (data.subscription?.id) {
    return { subscriptionId: data.subscription.id, status: data.subscription.status };
  }
  console.error("[hab/join] subscription create failed:", JSON.stringify(data));
  return {
    subscriptionId: "",
    status: "",
    error: data.errors?.[0]?.detail || "Subscription create failed",
  };
}

export async function processHabJoin(
  input: HabJoinInput,
): Promise<HabJoinResult | { error: string; status?: number }> {
  // 1. Authoritative plan — server clock, never the client's numbers.
  const plan = computeJoinPlan(habTodayYmd());
  if (plan.status === "closed") {
    return { error: "The Have-A-Ball season has ended — signups are closed.", status: 409 };
  }
  if (plan.remainingCharges === 0) {
    // Final week: nothing left to subscribe to. Hand to staff rather than
    // charging a full season as a lump sum.
    return {
      error: "It's the final week of the season — please call HeadPinz to join.",
      status: 409,
    };
  }

  // 2. Customer + card on file
  const cust = await createCustomer({
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    note: input.phone ? `Have-A-Ball signup. Phone: ${input.phone}` : "Have-A-Ball signup",
  });
  if (cust.error) return { error: cust.error };

  const card = await saveCard({ customerId: cust.customerId, cardToken: input.cardToken });
  if (card.error) return { error: card.error };

  // 3. Back-pay (weeks already played) — one immediate card-on-file charge.
  let backPayPaymentId: string | null = null;
  if (plan.backPayWeeks > 0) {
    const order = await createBackPayOrder({
      customerId: cust.customerId,
      weeks: plan.backPayWeeks,
    });
    if (order.error) return { error: `Back-pay: ${order.error}` };

    const charge = await chargeBackPay({
      customerId: cust.customerId,
      cardId: card.cardId,
      orderId: order.orderId,
      amountCents: order.totalCents, // Square-authoritative total (tax included)
      // Square caps idempotency_key at 45 chars. joinAttemptId is a 36-char
      // UUID, so the prefix must stay short: "bp-" + 36 = 39.
      idempotencyKey: `bp-${input.joinAttemptId}`,
    });
    if (charge.error) return { error: `Back-pay charge: ${charge.error}` };
    backPayPaymentId = charge.paymentId;
  }

  // 4. Subscription for the remaining weeks, capped at season end.
  const template = await createSubTemplate(cust.customerId);
  if (template.error) {
    return {
      error: `${template.error} (back-pay ${backPayPaymentId ? "WAS" : "was not"} charged — contact ops)`,
    };
  }

  const sub = await createSubscription({
    customerId: cust.customerId,
    cardId: card.cardId,
    startDate: plan.subStartDate,
    canceledDate: plan.canceledDate,
    orderTemplateId: template.orderId,
  });
  if (sub.error) {
    return {
      error: `${sub.error} (back-pay ${backPayPaymentId ? "WAS" : "was not"} charged — contact ops)`,
    };
  }

  // 5. Persist + notify (non-fatal — money already moved).
  const record = {
    subscriptionId: sub.subscriptionId,
    customerId: cust.customerId,
    cardId: card.cardId,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone,
    dob: input.dob,
    teamName: input.teamName || null,
    smsOptIn: input.smsOptIn ?? false,
    startDate: plan.subStartDate,
    backPayWeeks: plan.backPayWeeks,
    backPayAmountCents: plan.backPayAmountCents,
    backPayPaymentId,
    remainingCharges: plan.remainingCharges,
    seasonTotalCents: plan.seasonTotalCents,
    signedUpAt: new Date().toISOString(),
  };
  try {
    await redis.set(
      `league:haveaball:signup:${sub.subscriptionId}`,
      JSON.stringify(record),
      "EX",
      SIGNUP_TTL,
    );
    await redis.zadd(SIGNUP_INDEX_KEY, Date.now(), sub.subscriptionId);
    await redis.expire(SIGNUP_INDEX_KEY, SIGNUP_TTL);
  } catch (err) {
    console.error("[hab/join] signup persist failed (non-fatal):", err);
  }

  try {
    await sendHabConfirmationEmail({
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      dob: input.dob || undefined,
      teamName: input.teamName || undefined,
      subscriptionId: sub.subscriptionId,
      backPayPaymentId,
      plan,
    });
  } catch (err) {
    console.error("[hab/join] email send failed (non-fatal):", err);
  }

  return {
    ok: true,
    subscriptionId: sub.subscriptionId,
    customerId: cust.customerId,
    cardId: card.cardId,
    backPayPaymentId,
    plan,
  };
}
