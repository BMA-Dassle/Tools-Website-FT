import { NextRequest, NextResponse } from "next/server";
import { getBowlingReservation } from "@/lib/bowling-db";
import { sql } from "@/lib/db";

/**
 * PATCH /api/bowling/v2/reservations/[id]/food
 *
 * Self-service edit of a Pizza Bowl's PIZZA TOPPINGS + SODA flavor, allowed up
 * until check-in. The toppings/drink live as notes on the day-of Square order's
 * "Pizza Bowl Pizza" / "Pizza Bowl Soda Pitcher" lines, so a change is just a
 * note update on that order — the kitchen KDS reflects it automatically.
 *
 * Money: add-only. Swapping toppings or picking fewer is free (we never refund).
 * Picking MORE toppings than already paid (extra toppings are $1 each beyond the
 * 1 free/lane) charges only the difference via a re-entered card.
 *
 * Flow:
 *  1. Load reservation + editability guard (status, not checked in, future)
 *  2. Fetch the OPEN day-of order; derive currently-paid extra-topping $
 *  3. diff = max(0, newExtra − currentExtra); enforce displayed == charged
 *  4. If diff > 0: charge the card for diff FIRST (nothing applied on failure)
 *  5. PUT order: update pizza/soda line notes + add the paid extra-topping line
 *  6. Persist the new food lines to Neon (best-effort)
 *
 * Body: {
 *   rawItems: Array<{ catalogObjectId, name, quantity, note?, modifiers? }>,  // pizza/soda only
 *   extraToppingsCents: number,   // new TOTAL extra-topping surcharge for the order
 *   expectedDiffCents: number,    // client-displayed difference (displayed-vs-charged guard)
 *   squareToken?: string,         // Web Payments nonce, required iff diff > 0
 * }
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";

const PIZZA_CATALOG_ID = "2IKZB4O2HQBXWMTSUQ2SEKJY";
const SODA_CATALOG_ID = "SJUBJLB4QGHIHCW5AKTTMLH7";
const ALLOWED_FOOD = new Set([PIZZA_CATALOG_ID, SODA_CATALOG_ID]);
const EXTRA_TOPPING_NAME = "Extra Pizza Topping";
const EXTRA_TOPPING_CENTS = 100;
const EXTRA_TOPPING_RE = /extra\s+pizza\s+topping/i;

function sqHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/** square_dayof_order_id may be a bare id or a JSON array (combo legs). */
function firstOrderId(raw?: string): string | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p) && p.length) return String(p[0]);
  } catch {
    /* bare id */
  }
  return raw;
}

interface FoodItem {
  catalogObjectId: string;
  name: string;
  quantity: number;
  note?: string;
  modifiers?: Array<{ catalog_object_id: string }>;
}
interface SquareLineItem {
  uid: string;
  name?: string;
  note?: string;
  quantity?: string;
  catalog_object_id?: string;
  base_price_money?: { amount?: number };
}

function buildAddLine(ri: FoodItem) {
  return {
    catalog_object_id: ri.catalogObjectId,
    quantity: String(ri.quantity),
    ...(ri.modifiers?.length
      ? { applied_modifiers: ri.modifiers.map((m) => ({ catalog_object_id: m.catalog_object_id })) }
      : {}),
    ...(ri.note ? { note: ri.note } : {}),
  };
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const neonId = parseInt(id, 10);
  if (isNaN(neonId) || neonId < 1) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  let body: {
    rawItems?: FoodItem[];
    extraToppingsCents?: number;
    expectedDiffCents?: number;
    squareToken?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const rawItems = (body.rawItems ?? []).filter((ri) => ri && ALLOWED_FOOD.has(ri.catalogObjectId));
  if (rawItems.length === 0) {
    return NextResponse.json({ error: "no pizza/soda items provided" }, { status: 400 });
  }
  const newExtraCents = Math.max(0, Math.round(body.extraToppingsCents ?? 0));

  // ── 1. Load + editability guard ──────────────────────────────────
  const res = await getBowlingReservation(neonId);
  if (!res) return NextResponse.json({ error: "reservation not found" }, { status: 404 });
  if (res.status !== "confirmed" && res.status !== "confirm_pending") {
    return NextResponse.json({ error: `not editable (status ${res.status})` }, { status: 409 });
  }
  if (res.dayofOrderSentAt) {
    return NextResponse.json({ error: "already checked in — see staff" }, { status: 409 });
  }
  if (new Date(res.bookedAt).getTime() <= Date.now()) {
    return NextResponse.json({ error: "session already started — see staff" }, { status: 409 });
  }
  const orderId = firstOrderId(res.squareDayofOrderId);
  if (!orderId) {
    return NextResponse.json({ error: "no day-of order on file" }, { status: 409 });
  }

  // ── 2. Fetch the OPEN day-of order ───────────────────────────────
  const oRes = await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
    headers: sqHeaders(),
    cache: "no-store",
  });
  if (!oRes.ok) {
    return NextResponse.json({ error: "could not load order" }, { status: 502 });
  }
  const order = (await oRes.json()).order as
    | { state?: string; version?: number; location_id?: string; line_items?: SquareLineItem[] }
    | undefined;
  if (!order || order.version == null) {
    return NextResponse.json({ error: "order missing" }, { status: 502 });
  }
  if (order.state !== "OPEN") {
    return NextResponse.json(
      { error: `order not editable (state ${order.state})` },
      { status: 409 },
    );
  }
  const locationId = order.location_id;
  const items = order.line_items ?? [];

  // ── 3. Compute the add-only difference + displayed-vs-charged guard ─
  const currentExtraCents = items
    .filter((li) => EXTRA_TOPPING_RE.test(li.name ?? ""))
    .reduce(
      (s, li) =>
        s + (li.base_price_money?.amount ?? EXTRA_TOPPING_CENTS) * Number(li.quantity ?? 0),
      0,
    );
  const diff = Math.max(0, newExtraCents - currentExtraCents);

  if (typeof body.expectedDiffCents === "number" && body.expectedDiffCents !== diff) {
    // Hard fail — never charge an amount the guest didn't see (project rule).
    return NextResponse.json(
      { error: "price changed, please refresh", expectedDiffCents: body.expectedDiffCents, diff },
      { status: 409 },
    );
  }
  if (diff > 0 && !body.squareToken) {
    return NextResponse.json(
      { error: "payment required for added toppings", diff },
      { status: 400 },
    );
  }

  // ── 4. Charge the difference FIRST (nothing is applied if this fails) ─
  let paymentId: string | undefined;
  if (diff > 0) {
    const payRes = await fetch(`${SQUARE_BASE}/payments`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `food-edit-${neonId}-${newExtraCents}-pay`,
        source_id: body.squareToken,
        amount_money: { amount: diff, currency: "USD" },
        order_id: orderId,
        location_id: locationId,
        autocomplete: true,
        ...(res.squareCustomerId ? { customer_id: res.squareCustomerId } : {}),
        note: `Pizza topping change — reservation #${neonId}`,
      }),
    });
    if (!payRes.ok) {
      const errBody = (await payRes.json().catch(() => ({}))) as {
        errors?: { detail?: string }[];
      };
      return NextResponse.json(
        { error: errBody.errors?.[0]?.detail ?? "payment failed", diff },
        { status: 402 },
      );
    }
    paymentId = ((await payRes.json()) as { payment?: { id?: string } }).payment?.id;
  }

  // ── 5. Update pizza/soda notes + add the paid extra-topping line ─────
  // Pizza/soda counts are fixed (1 per lane), so only NOTES change — match new
  // selections to existing lines by order. Missing lines (older pre-fix orders)
  // are added. Square merges line_items by uid; items with no uid are appended.
  const pizzaLines = items.filter((li) => li.catalog_object_id === PIZZA_CATALOG_ID);
  const sodaLines = items.filter((li) => li.catalog_object_id === SODA_CATALOG_ID);
  const newPizza = rawItems.filter((ri) => ri.catalogObjectId === PIZZA_CATALOG_ID);
  const newSoda = rawItems.filter((ri) => ri.catalogObjectId === SODA_CATALOG_ID);

  const lineItemWrites: Array<Record<string, unknown>> = [];
  newPizza.forEach((ri, i) => {
    if (pizzaLines[i]) lineItemWrites.push({ uid: pizzaLines[i].uid, note: ri.note ?? "" });
    else lineItemWrites.push(buildAddLine(ri));
  });
  newSoda.forEach((ri, i) => {
    if (sodaLines[i]) lineItemWrites.push({ uid: sodaLines[i].uid, note: ri.note ?? "" });
    else lineItemWrites.push(buildAddLine(ri));
  });
  if (diff > 0) {
    lineItemWrites.push({
      name: EXTRA_TOPPING_NAME,
      quantity: String(diff / EXTRA_TOPPING_CENTS),
      base_price_money: { amount: EXTRA_TOPPING_CENTS, currency: "USD" },
    });
  }

  const putRes = await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
    method: "PUT",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `food-edit-${neonId}-${newExtraCents}-${order.version}`,
      order: { location_id: locationId, version: order.version, line_items: lineItemWrites },
    }),
  });
  if (!putRes.ok) {
    const errBody = (await putRes.json().catch(() => ({}))) as { errors?: { detail?: string }[] };
    // If we already charged, the payment sits on the order as a credit (the
    // extra-topping line was never added), so the guest is not out money —
    // surface loudly for ops rather than silently dropping it.
    console.error(
      `[food-edit] neonId=${neonId} order PUT failed after charge=${paymentId ?? "none"}:`,
      errBody.errors?.[0]?.detail ?? putRes.status,
    );
    return NextResponse.json(
      {
        error: "order update failed",
        chargedButNotApplied: !!paymentId,
        paymentId,
      },
      { status: 502 },
    );
  }

  // ── 6. Persist the new food selection to Neon (best-effort) ─────────
  try {
    const q = sql();
    await q`
      DELETE FROM bowling_reservation_lines
      WHERE reservation_id = ${neonId}
        AND (label ILIKE 'Pizza Bowl Pizza%' OR label ILIKE 'Pizza Bowl Soda%'
             OR label ILIKE 'Extra Pizza Topping%')
    `;
    for (const ri of rawItems) {
      await q`
        INSERT INTO bowling_reservation_lines (reservation_id, label, quantity, unit_price_cents)
        VALUES (${neonId}, ${ri.note ? `${ri.name} — ${ri.note}` : ri.name}, ${ri.quantity}, 0)
      `;
    }
    if (newExtraCents > 0) {
      await q`
        INSERT INTO bowling_reservation_lines (reservation_id, label, quantity, unit_price_cents)
        VALUES (${neonId}, ${EXTRA_TOPPING_NAME}, ${Math.round(newExtraCents / EXTRA_TOPPING_CENTS)}, ${EXTRA_TOPPING_CENTS})
      `;
    }
  } catch (err) {
    // Non-fatal — the Square order (kitchen source of truth) is already updated.
    console.warn(`[food-edit] neonId=${neonId} line persist failed (non-fatal):`, err);
  }

  return NextResponse.json({ ok: true, chargedCents: diff, paymentId: paymentId ?? null });
}
