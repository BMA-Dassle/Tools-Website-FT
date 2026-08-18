import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/admin/bowling/square-order?token=...&orderId=...
 *
 * Fetches a Square day-of order by ID and returns its line items.
 * Used by the admin reservations page — and by the portal's events page (Payments tab →
 * "Square Order") — to inspect order contents.
 *
 * SERVICE CHARGES ARE PART OF THE TOTAL. This originally returned only line items + tax,
 * so a Square `service_charges` entry was invisible and the displayed figures did not add
 * up to the total. It went unnoticed because group-function service charges used to arrive
 * disguised as a "Legacy Service Charge" LINE ITEM, so they happened to be counted; once
 * they moved to the correct slot (see lib/gf-square-tax.ts) the gap showed as
 * `subtotal + tax != total`. `subtotalCents` and `serviceChargeCents` are now returned
 * explicitly so no consumer has to infer either by subtraction.
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN ?? ""}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const token = searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const orderId = searchParams.get("orderId");
  if (!orderId) {
    return NextResponse.json({ error: "orderId required" }, { status: 400 });
  }

  try {
    const res = await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
      headers: sqHeaders(),
      cache: "no-store",
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        errors?: Array<{ detail?: string }>;
      };
      return NextResponse.json(
        { error: body.errors?.[0]?.detail ?? `Square ${res.status}` },
        { status: res.status >= 500 ? 502 : res.status },
      );
    }

    const { order } = (await res.json()) as {
      order?: {
        id: string;
        state: string;
        total_money?: { amount: number; currency: string };
        total_tax_money?: { amount: number; currency: string };
        total_discount_money?: { amount: number; currency: string };
        total_service_charge_money?: { amount: number; currency: string };
        net_amount_due_money?: { amount: number; currency: string };
        service_charges?: Array<{
          uid?: string;
          name?: string;
          taxable?: boolean;
          /** Pre-tax service-charge amount. `total_money` here is tax-INCLUSIVE. */
          applied_money?: { amount: number; currency: string };
          total_money?: { amount: number; currency: string };
          total_tax_money?: { amount: number; currency: string };
        }>;
        line_items?: Array<{
          uid: string;
          name?: string;
          quantity: string;
          note?: string;
          catalog_object_id?: string;
          base_price_money?: { amount: number; currency: string };
          gross_sales_money?: { amount: number; currency: string };
          total_tax_money?: { amount: number; currency: string };
          total_discount_money?: { amount: number; currency: string };
          total_money?: { amount: number; currency: string };
        }>;
      };
    };

    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    // Flatten to a simpler shape for the admin UI
    // Use gross_sales (pre-tax, pre-discount) for display; show tax separately
    const lineItems = (order.line_items ?? []).map((li) => {
      const qty = parseInt(li.quantity, 10);
      const baseCents = li.base_price_money?.amount ?? 0;
      // gross_sales = base * qty (pre-tax, pre-discount). Fallback: compute it.
      const grossCents = li.gross_sales_money?.amount ?? baseCents * qty;
      return {
        uid: li.uid,
        name: li.name ?? "—",
        quantity: qty,
        note: li.note ?? null,
        priceCents: baseCents,
        grossCents,
        taxCents: li.total_tax_money?.amount ?? 0,
        discountCents: li.total_discount_money?.amount ?? 0,
        totalCents: li.total_money?.amount ?? 0,
        catalogId: li.catalog_object_id ?? null,
      };
    });

    // Pre-tax, so it sits alongside the line items' grossCents in a Subtotal row.
    const serviceCharges = (order.service_charges ?? []).map((sc) => ({
      uid: sc.uid ?? null,
      name: sc.name ?? "Service charge",
      amountCents: sc.applied_money?.amount ?? 0,
      taxCents: sc.total_tax_money?.amount ?? 0,
      taxable: sc.taxable ?? false,
    }));
    const subtotalCents = lineItems.reduce((s, li) => s + li.grossCents, 0);
    const serviceChargeCents =
      order.total_service_charge_money?.amount ??
      serviceCharges.reduce((s, sc) => s + sc.amountCents, 0);

    return NextResponse.json({
      orderId: order.id,
      state: order.state,
      totalCents: order.total_money?.amount ?? 0,
      taxCents: order.total_tax_money?.amount ?? 0,
      discountCents: order.total_discount_money?.amount ?? 0,
      remainingCents: order.net_amount_due_money?.amount ?? 0,
      /** Line items only, pre-tax. subtotal + serviceCharge + tax - discount = total. */
      subtotalCents,
      serviceChargeCents,
      serviceCharges,
      lineItems,
    });
  } catch (err) {
    console.error("[admin/square-order]", err);
    return NextResponse.json({ error: "Failed to fetch order" }, { status: 500 });
  }
}
