import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/admin/bowling/square-order?token=...&orderId=...
 *
 * Fetches a Square day-of order by ID and returns its line items.
 * Used by the admin reservations page to inspect order contents.
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
        net_amount_due_money?: { amount: number; currency: string };
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

    return NextResponse.json({
      orderId: order.id,
      state: order.state,
      totalCents: order.total_money?.amount ?? 0,
      taxCents: order.total_tax_money?.amount ?? 0,
      discountCents: order.total_discount_money?.amount ?? 0,
      remainingCents: order.net_amount_due_money?.amount ?? 0,
      lineItems,
    });
  } catch (err) {
    console.error("[admin/square-order]", err);
    return NextResponse.json({ error: "Failed to fetch order" }, { status: 500 });
  }
}
