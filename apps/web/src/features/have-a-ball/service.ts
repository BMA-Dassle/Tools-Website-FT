import { randomUUID } from "crypto";
import redis from "@/lib/redis";
import {
  computeJoinPlan,
  habMinusOneDay,
  habPlanVariationForRemaining,
  habTodayYmd,
  HAB_ITEM_VARIATION_ID,
  HAB_LEE_COUNTY_TAX_ID,
  HAB_LOCATION_ID,
  type JoinPlan,
} from "./schedule";
import { sendHabConfirmationEmail } from "./email";

/**
 * Have-A-Ball join orchestration.
 *
 * One atomic flow:
 *   1. Create Square customer (email-only — phone kept in our record)
 *   2. Save the card on file
 *   3. Recompute the join plan SERVER-SIDE (never trust client amounts)
 *   4. Subscription: create it starting the next Tuesday on the plan variation
 *      whose fixed period count == the weeks remaining, so it bills exactly that
 *      many Tuesdays and completes on its own. A mid-season joiner is billed only
 *      for the weeks that remain — no catch-up charge.
 *   5. Persist the signup record + send the confirmation email
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
  /** Client-generated id so a network retry can't create a duplicate subscription. */
  joinAttemptId: string;
}

export interface HabJoinResult {
  ok: true;
  subscriptionId: string;
  customerId: string;
  cardId: string;
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
  planVariationId: string;
  orderTemplateId: string;
  idempotencyKey: string;
}): Promise<{ subscriptionId: string; status: string; error?: string }> {
  const res = await fetch(`${SQUARE_BASE}/subscriptions`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: p.idempotencyKey,
      location_id: HAB_LOCATION_ID,
      // Variation whose fixed `periods` count == the weeks remaining, so the
      // subscription bills exactly that many Tuesdays and completes on its own —
      // no canceled_date needed (which also avoids Square's +1 shift on the cap).
      plan_variation_id: p.planVariationId,
      customer_id: p.customerId,
      card_id: p.cardId,
      // Square stores an explicit future start_date as +1 day, so we send
      // (intended − 1) to land the first charge on the intended Tuesday.
      start_date: habMinusOneDay(p.startDate),
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
    // Final week: nothing left to subscribe to. Hand to staff.
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

  // 3. Subscription for the remaining weeks, capped at season end. A mid-season
  // joiner pays only for the weeks left — no charge today; first bill is the
  // next Tuesday.
  const template = await createSubTemplate(cust.customerId);
  if (template.error) return { error: template.error };

  const sub = await createSubscription({
    customerId: cust.customerId,
    cardId: card.cardId,
    startDate: plan.subStartDate,
    planVariationId: habPlanVariationForRemaining(plan.remainingCharges),
    orderTemplateId: template.orderId,
    // Square caps idempotency_key at 45 chars. joinAttemptId is a 36-char UUID,
    // so the prefix must stay short: "sub-" + 36 = 40. Keyed off the attempt id
    // so a network retry can't create a duplicate subscription.
    idempotencyKey: `sub-${input.joinAttemptId}`,
  });
  if (sub.error) return { error: sub.error };

  // 4. Persist + notify (non-fatal — subscription already created).
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
    remainingCharges: plan.remainingCharges,
    totalDueCents: plan.totalDueCents,
    // Disclosure-only: retro owed for weeks already played, collected by staff
    // separately — NOT charged by this flow.
    missedWeeks: plan.missedWeeks,
    retroAmountCents: plan.retroAmountCents,
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
    plan,
  };
}
