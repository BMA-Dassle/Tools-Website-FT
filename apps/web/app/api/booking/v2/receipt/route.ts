import { NextRequest, NextResponse } from "next/server";
import {
  getBowlingReservationByBillId,
  getBowlingReservationByShortCode,
  type BowlingReservation,
} from "@/lib/bowling-db";

/**
 * GET /api/booking/v2/receipt?billId=…  (or ?shortCode=…)
 *
 * Returns the itemized day-of Square order for a v2 booking — "exactly what
 * they paid for" — for the confirmation page. The unified/bowling reserve paths
 * build ONE combined Square day-of order (every activity + booking fee + any
 * loyalty reward discount + tax) and persist its id on the Neon reservation row
 * (square_dayof_order_id). We resolve the row from the confirmation identifier,
 * fetch the live Square order, and return a sanitized breakdown (line names +
 * amounts, discounts, tax, total) plus what was paid online (the deposit) vs.
 * the balance settled at check-in.
 *
 * Sourcing from Square (not the stored BMI/booking overviews) is deliberate: the
 * Square order is the authoritative, complete itemization — the stored overviews
 * can be partial for multi-activity bookings and don't carry the reward discount.
 *
 * Non-critical: any miss (no row, no order id, Square error) returns
 * { available: false } so the confirmation page simply omits the section.
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";

function squareHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Square-Version": "2024-12-18",
    "Content-Type": "application/json",
  };
}

interface SquareMoney {
  amount?: number;
}
interface SquareLineItem {
  name?: string;
  quantity?: string;
  gross_sales_money?: SquareMoney;
  total_money?: SquareMoney;
}
interface SquareDiscount {
  name?: string;
  amount_money?: SquareMoney;
}
interface SquareOrder {
  state?: string;
  line_items?: SquareLineItem[];
  discounts?: SquareDiscount[];
  total_discount_money?: SquareMoney;
  total_tax_money?: SquareMoney;
  total_money?: SquareMoney;
}

const UNAVAILABLE = NextResponse.json({ available: false });

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const billId = params.get("billId") || params.get("orderId") || "";
  const shortCode = params.get("shortCode") || params.get("code") || "";

  if (!SQUARE_TOKEN || (!billId && !shortCode)) return UNAVAILABLE;

  try {
    let row: BowlingReservation | null = null;
    if (billId) row = await getBowlingReservationByBillId(billId);
    if (!row && shortCode) row = await getBowlingReservationByShortCode(shortCode);

    const orderId = row?.squareDayofOrderId;
    if (!orderId) return UNAVAILABLE;

    const res = await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
      headers: squareHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return UNAVAILABLE;

    const order = (await res.json())?.order as SquareOrder | undefined;
    if (!order) return UNAVAILABLE;

    const lineItems = (order.line_items ?? [])
      .map((li) => ({
        name: li.name || "Item",
        quantity: Number(li.quantity ?? "1") || 1,
        // gross (pre-discount, pre-tax) so the receipt reads item → discount → tax
        amountCents: li.gross_sales_money?.amount ?? li.total_money?.amount ?? 0,
      }))
      .filter((l) => l.amountCents > 0 || l.quantity > 0);

    const discounts = (order.discounts ?? [])
      .map((d) => ({ name: d.name || "Discount", amountCents: d.amount_money?.amount ?? 0 }))
      .filter((d) => d.amountCents > 0);

    const taxCents = order.total_tax_money?.amount ?? 0;
    const totalCents = order.total_money?.amount ?? 0;
    const paidOnlineCents = row?.depositCents ?? 0;
    const dueAtCenterCents = Math.max(0, totalCents - paidOnlineCents);

    return NextResponse.json({
      available: true,
      lineItems,
      discounts,
      discountCents: order.total_discount_money?.amount ?? 0,
      taxCents,
      totalCents,
      paidOnlineCents,
      dueAtCenterCents,
    });
  } catch (err) {
    console.warn("[booking/v2/receipt] failed:", err);
    return UNAVAILABLE;
  }
}
