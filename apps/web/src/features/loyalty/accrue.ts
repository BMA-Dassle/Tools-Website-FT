/**
 * HeadPinz Rewards — point accrual against a paid Square order.
 *
 * WHY THIS EXISTS AS ONE SHARED FUNCTION
 * --------------------------------------
 * Square does NOT accrue loyalty points on its own for Orders-API orders.
 * `customer_id` on the order is necessary but NOT sufficient — an explicit
 * AccumulateLoyaltyPoints call is the only thing that credits a member. Square's
 * first-party surfaces (POS, Terminal, Square Online) do that call for you; our
 * own checkout does not, so every rail that finishes paying a day-of order has
 * to make it.
 *
 * Bowling had that call inline in `processLaneOpen`. Racing and standalone
 * attractions — settled by the race-dayof-pay cron — never did, so a rewards
 * member who booked a race online earned nothing for it while the same guest
 * earned normally when a cashier rang them up at the register. Measured
 * 2026-08-27 against Square's own ledger: 1,161 of 1,166 fully-paid,
 * customer-linked race orders since 2026-05-31 had ZERO accrual events —
 * $100,095.49 of eligible spend, ~1,000,268 Pinz (~$10,002 of guest value).
 *
 * Rather than copy the block a second time (and let the two drift — see
 * tasks/lessons.md on extracted code missing later fixes), both rails call this.
 *
 * PRECONDITION Square enforces: the order must be paid or completed. Calling on
 * an order with a balance due returns BAD_REQUEST. Callers should invoke this
 * only once `net_amount_due` has reached 0 — it is otherwise a no-op that logs.
 *
 * ELIGIBILITY is Square's to decide, not ours. The program's accrual rule is
 * SPEND (10 Pinz per $1) with category/item exclusion lists maintained in the
 * Square dashboard. We deliberately do not mirror those lists here — we hand
 * Square the order id and let it compute. Racing ("Karting", "Race Pack",
 * category IC2BH6F6KBJ5BBSSSGXJPSZF) is NOT excluded; the excluded karting
 * categories are the Group-Function ones ("GF Karting", "GF Karting Buyout").
 *
 * BEST-EFFORT BY DESIGN: a loyalty failure must never fail a settle. Every path
 * returns a result object and never throws.
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";

export interface AccrueLoyaltyInput {
  /** The PAID Square order to accrue against (day-of order, not the deposit). */
  orderId: string;
  /**
   * Square location the order lives on. Must be one of the program's
   * `location_ids` or Square rejects the accrual. Pass the ORDER's
   * `location_id` — for racing that is the FastTrax location (LAB52GY480CJF),
   * which differs from the reservation's centerCode.
   */
  locationId: string;
  /**
   * Square customer to credit. Prefer the order's own `customer_id`; fall back
   * to the value stored on the reservation. When absent there is nobody to
   * credit and we skip.
   */
  customerId?: string | null;
  /** Stable key so a retried settle cannot double-credit the same order. */
  idempotencyKey: string;
  /** Log prefix, e.g. `[race-dayof-pay] neonId=123`. */
  logTag?: string;
}

export type AccrueLoyaltyResult =
  | { status: "accrued"; points: number; loyaltyAccountId: string }
  | { status: "no_customer" }
  | { status: "no_account"; customerId: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

function sqHeaders() {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN || ""}`,
    "Square-Version": SQUARE_VERSION,
    "Content-Type": "application/json",
  };
}

/**
 * Credit HeadPinz Rewards points for a paid Square order.
 *
 * Safe to call unconditionally after a settle: it resolves the loyalty account
 * itself, and returns a descriptive status instead of throwing.
 */
export async function accrueLoyaltyPoints(input: AccrueLoyaltyInput): Promise<AccrueLoyaltyResult> {
  const { orderId, locationId, idempotencyKey } = input;
  const tag = input.logTag ?? "[loyalty]";

  if (!input.customerId) return { status: "no_customer" };
  if (!orderId || !locationId) return { status: "skipped", reason: "missing orderId/locationId" };

  try {
    // 1. customer → loyalty account. A Square customer exists for card-on-file
    //    too, so most customers have NO loyalty account; that is not an error.
    const searchRes = await fetch(`${SQUARE_BASE}/loyalty/accounts/search`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({ query: { customer_ids: [input.customerId] }, limit: 1 }),
    });
    if (!searchRes.ok) {
      const detail = await searchRes.text();
      console.warn(`${tag} loyalty account search ${searchRes.status}: ${detail.slice(0, 200)}`);
      return { status: "error", reason: `account search ${searchRes.status}` };
    }
    const searchData = (await searchRes.json()) as { loyalty_accounts?: { id: string }[] };
    const loyaltyAccountId = searchData.loyalty_accounts?.[0]?.id;
    if (!loyaltyAccountId) return { status: "no_account", customerId: input.customerId };

    // 2. Accrue. Square reads the order's catalog lines and applies the program's
    //    accrual rule + exclusions.
    const accRes = await fetch(`${SQUARE_BASE}/loyalty/accounts/${loyaltyAccountId}/accumulate`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        accumulate_points: { order_id: orderId },
        location_id: locationId,
        idempotency_key: idempotencyKey,
      }),
    });

    if (!accRes.ok) {
      // Most common non-fatal cause: the order still has a balance due, or this
      // order already accrued. Never fatal to the caller's settle.
      const err = (await accRes.json().catch(() => ({}))) as {
        errors?: { detail?: string; code?: string }[];
      };
      const reason = err.errors?.[0]?.detail ?? `HTTP ${accRes.status}`;
      console.log(`${tag} loyalty accumulate skipped: ${reason}`);
      return { status: "skipped", reason };
    }

    const accData = (await accRes.json()) as {
      events?: { accumulate_points?: { points?: number } }[];
    };
    const points = (accData.events ?? []).reduce(
      (sum, e) => sum + (e.accumulate_points?.points ?? 0),
      0,
    );
    console.log(`${tag} loyalty accrued ${points} pts (acct ${loyaltyAccountId})`);
    return { status: "accrued", points, loyaltyAccountId };
  } catch (err) {
    console.warn(`${tag} loyalty accrual threw:`, err);
    return { status: "error", reason: (err as Error).message };
  }
}
