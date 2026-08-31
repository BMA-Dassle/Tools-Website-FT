import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getGfQuoteByShortId, updateGfQuoteDetails } from "@/lib/group-function-db";
import { createDayofOrder } from "@/lib/group-function-dayof";
import { isAdminCredential } from "@/lib/admin-request-auth";

/**
 * POST /api/admin/group-functions/backfill-dayof
 *
 * Creates a missing Square day-of order for a group function quote
 * and saves the order ID to the DB. Used when the day-of order
 * creation failed silently during the deposit flow.
 *
 * Body: { shortId, token }
 *
 * Delegates to createDayofOrder — which group-function-dayof.ts declares the single
 * source of truth for day-of order creation. This route used to carry its own copy of
 * the order-building logic, and that copy is exactly how the tax/service-charge
 * misclassification survived being fixed in one place: both writers had to be found.
 * Do not re-inline it.
 */

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { shortId, token } = body as { shortId: string; token: string };

  if (!(await isAdminCredential(token))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!shortId) {
    return NextResponse.json({ error: "shortId required" }, { status: 400 });
  }

  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  if (quote.square_dayof_order_id) {
    return NextResponse.json({
      ok: true,
      action: "already_exists",
      dayofOrderId: quote.square_dayof_order_id,
    });
  }

  const dayof = await createDayofOrder(quote, `backfill-${randomBytes(8).toString("hex")}`);
  if (!dayof) {
    return NextResponse.json({ error: "Failed to create day-of order" }, { status: 500 });
  }

  await updateGfQuoteDetails(quote.id, { square_dayof_order_id: dayof.id });

  console.log(`[backfill-dayof] created day-of order ${dayof.id} for quote ${quote.id}`);

  return NextResponse.json({
    ok: true,
    action: "created",
    dayofOrderId: dayof.id,
    totalCents: dayof.totalCents,
    quoteId: quote.id,
  });
}
