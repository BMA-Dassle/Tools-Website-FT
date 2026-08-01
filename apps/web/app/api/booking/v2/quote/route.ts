import { NextRequest, NextResponse } from "next/server";
import { quoteUnifiedSession } from "~/features/booking/service/unified-reserve";
import type { BookingSession } from "~/features/booking/state/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/booking/v2/quote { session }
 *
 * Server-authoritative pricing for the review screens (owner 2026-07-31:
 * "we shouldn't be calculating this on client side at all"). Returns the SAME
 * lines the reserve will charge — charged lines with money, covered units as
 * their own $0 lines tagged with why (Credit / Race Pack / Voucher) — so
 * displayed ≡ charged by construction. Pure compute: no Square calls, no
 * voucher claims, no writes; safe to call on every cart change.
 *
 * Bowling-ONLY carts keep their existing tax-inclusive quote
 * (/api/square/bowling-orders/quote); this covers the unified rail's carts.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { session?: BookingSession } | null;
    if (!body?.session?.items?.length) {
      return NextResponse.json({ error: "No items in session" }, { status: 400 });
    }
    return NextResponse.json(quoteUnifiedSession(body.session));
  } catch (err) {
    console.error("[v2/quote] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "quote failed" },
      { status: 500 },
    );
  }
}
