import { NextRequest, NextResponse } from "next/server";
import {
  getBowlingReservationByBillId,
  getBowlingReservationByShortCode,
  listComboSiblingReservations,
  type BowlingReservation,
} from "@/lib/bowling-db";
import { getComboSpecial } from "~/features/combos";

/**
 * GET /api/booking/v2/receipt?billId=…  (or ?shortCode=…)
 *
 * Returns the itemized day-of Square order(s) for a v2 booking — "exactly what
 * they paid for" — for the confirmation page. The unified/bowling reserve paths
 * build ONE day-of Square order per settlement center and persist its id on the
 * Neon reservation row (square_dayof_order_id). A combo special (Ultimate VIP)
 * splits into TWO orders — a FastTrax racing order + a HeadPinz bowling order —
 * on two rows correlated by their shared square_deposit_order_id. We resolve
 * the row from the confirmation identifier, pull in any combo sibling legs via
 * that shared deposit order, fetch the live Square orders, and return ONE
 * merged sanitized breakdown (line names + amounts, discounts, tax, total)
 * plus what was paid online vs. the balance settled at check-in. The combo's
 * internal revenue-split lines collapse into the single customer-facing combo
 * line, mirroring the cart's flatCartDisplay.
 *
 * Sourcing from Square (not the stored BMI/booking overviews) is deliberate: the
 * Square order is the authoritative, complete itemization — the stored overviews
 * can be partial for multi-activity bookings and don't carry the reward discount.
 *
 * Non-critical: any miss on the PRIMARY row/order (no row, no order id, Square
 * error) returns { available: false } so the confirmation page simply omits the
 * section. A failed combo SIBLING lookup/fetch degrades to the primary order
 * only (that leg's items AND its paid-online share drop together) — a slow
 * HeadPinz fetch never blanks the whole receipt.
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
  catalog_object_id?: string;
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

interface ReceiptLine {
  name: string;
  quantity: number;
  amountCents: number;
  catalogObjectId?: string;
}

async function fetchOrder(orderId: string): Promise<SquareOrder | null> {
  const res = await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
    headers: squareHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  return ((await res.json())?.order as SquareOrder | undefined) ?? null;
}

/**
 * Collapse the combo's internal revenue-split lines (one per settlement
 * center — live catalog names "VIP Experience Racing" / "VIP Experience
 * Bowling") into the single all-inclusive line the cart displayed
 * (flatCartDisplay): quantity is the per-person count (identical on every
 * split line), amount is the sum of the split amounts. Unmatched lines (perks
 * like the $0 chips & salsa) pass through; if nothing matches (pre-collapse
 * combos with itemized parts lines) the merged lines are returned untouched —
 * never hide a line we can't classify. Display-only: tax/total/paid still
 * come from the order-level sums.
 */
function collapseComboLines(lines: ReceiptLine[], comboSpecialId: string): ReceiptLine[] {
  const combo = getComboSpecial(comboSpecialId);
  if (!combo?.revenueSplit?.length) return lines;
  const splitIds = new Set(
    combo.revenueSplit.map((l) => l.catalogObjectId).filter((id): id is string => !!id),
  );
  const isSplitLine = (l: ReceiptLine) =>
    (!!l.catalogObjectId && splitIds.has(l.catalogObjectId)) || /VIP Experience/i.test(l.name);
  const matched = lines.filter(isSplitLine);
  if (matched.length === 0) return lines;
  const collapsed: ReceiptLine = {
    name: combo.name,
    quantity: Math.max(...matched.map((l) => l.quantity)),
    amountCents: matched.reduce((s, l) => s + l.amountCents, 0),
  };
  return [collapsed, ...lines.filter((l) => !isSplitLine(l))];
}

// Must be a fresh Response per request — a NextResponse body stream can only
// be sent once, so a shared module-level constant goes out empty after the
// first "unavailable" response since cold start.
const unavailable = () => NextResponse.json({ available: false });

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const billId = params.get("billId") || params.get("orderId") || "";
  const shortCode = params.get("shortCode") || params.get("code") || "";

  if (!SQUARE_TOKEN || (!billId && !shortCode)) return unavailable();

  try {
    let row: BowlingReservation | null = null;
    if (billId) row = await getBowlingReservationByBillId(billId);
    if (!row && shortCode) row = await getBowlingReservationByShortCode(shortCode);

    const primaryOrderId = row?.squareDayofOrderId;
    if (!row || !primaryOrderId) return unavailable();

    // Legs to fetch: the resolved row's order plus, for a combo, each sibling
    // leg's own order (post-split combos settle one order per center; the
    // resolved row can be EITHER leg — billId lands on the race row, a bowling
    // shortCode on the bowling row). Each leg carries ITS row's depositCents
    // (combos prepay 100% per leg). Deduped by order id so pre-split combos —
    // both rows pointing at one shared order — don't double-count items or
    // paid-online dollars.
    const legs: { orderId: string; paidCents: number }[] = [
      { orderId: primaryOrderId, paidCents: row.depositCents ?? 0 },
    ];
    if (row.comboSpecialId && row.squareDepositOrderId) {
      try {
        const siblings = await listComboSiblingReservations(
          row.squareDepositOrderId,
          row.comboSpecialId,
          row.id,
        );
        for (const s of siblings) {
          const oid = s.squareDayofOrderId;
          if (oid && !legs.some((l) => l.orderId === oid)) {
            legs.push({ orderId: oid, paidCents: s.depositCents ?? 0 });
          }
        }
      } catch (err) {
        console.warn("[booking/v2/receipt] combo sibling lookup failed; primary only:", err);
      }
    }

    const settled = await Promise.allSettled(legs.map((l) => fetchOrder(l.orderId)));
    const primary = settled[0];
    if (primary.status !== "fulfilled" || !primary.value) return unavailable();
    const fetched = settled.flatMap((r, i) =>
      r.status === "fulfilled" && r.value ? [{ order: r.value, paidCents: legs[i].paidCents }] : [],
    );

    let lineItems: ReceiptLine[] = fetched.flatMap(({ order }) =>
      (order.line_items ?? [])
        .map((li) => ({
          name: li.name || "Item",
          quantity: Number(li.quantity ?? "1") || 1,
          // gross (pre-discount, pre-tax) so the receipt reads item → discount → tax
          amountCents: li.gross_sales_money?.amount ?? li.total_money?.amount ?? 0,
          catalogObjectId: li.catalog_object_id,
        }))
        .filter((l) => l.amountCents > 0 || l.quantity > 0),
    );
    if (row.comboSpecialId) lineItems = collapseComboLines(lineItems, row.comboSpecialId);

    const discounts = fetched.flatMap(({ order }) =>
      (order.discounts ?? [])
        .map((d) => ({ name: d.name || "Discount", amountCents: d.amount_money?.amount ?? 0 }))
        .filter((d) => d.amountCents > 0),
    );

    const sum = (pick: (o: SquareOrder) => number | undefined) =>
      fetched.reduce((s, f) => s + (pick(f.order) ?? 0), 0);
    const taxCents = sum((o) => o.total_tax_money?.amount);
    const totalCents = sum((o) => o.total_money?.amount);
    const paidOnlineCents = fetched.reduce((s, f) => s + f.paidCents, 0);
    const dueAtCenterCents = Math.max(0, totalCents - paidOnlineCents);

    return NextResponse.json({
      available: true,
      lineItems: lineItems.map(({ name, quantity, amountCents }) => ({
        name,
        quantity,
        amountCents,
      })),
      discounts,
      discountCents: sum((o) => o.total_discount_money?.amount),
      taxCents,
      totalCents,
      paidOnlineCents,
      dueAtCenterCents,
    });
  } catch (err) {
    console.warn("[booking/v2/receipt] failed:", err);
    return unavailable();
  }
}
