import { NextRequest, NextResponse } from "next/server";

import {
  addOnPurchaseRequestSchema,
  bookAddOn,
  loadAddOnContext,
  serverHeatFreeSpots,
  AddOnContextError,
} from "~/features/combo-addon";
import { comboAddonEnabled, comboMaxAddPerTransaction, getComboSpecial } from "~/features/combos";
import { DepositPaymentError } from "~/features/booking/service/deposit";

/**
 * POST /api/book/add-on/purchase — add guests to a combo booking and charge.
 *
 * Books the new guests' heats into a fresh $0 BMI bill, seats them on the VIP
 * lane (adding a lane when needed), creates the add-on day-of order(s) + gift
 * card, and charges the card — all idempotent on the client idempotencyKey.
 * LIVE money path. Gated by the combo's addon policy + the env flag.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = addOnPurchaseRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Bad request" },
      { status: 400 },
    );
  }
  const { billId, guests, paymentToken, idempotencyKey, squareCustomerId } = parsed.data;

  try {
    const ctx = await loadAddOnContext(billId);
    const combo = getComboSpecial(ctx.comboSpecialId);
    if (!combo || !comboAddonEnabled(combo)) {
      return NextResponse.json(
        { error: "Guests can't be added to this booking." },
        { status: 403 },
      );
    }
    if (guests.length > comboMaxAddPerTransaction(combo)) {
      return NextResponse.json(
        { error: `You can add up to ${comboMaxAddPerTransaction(combo)} guests online.` },
        { status: 400 },
      );
    }

    const origin = new URL(req.url).origin;
    const result = await bookAddOn({
      ctx,
      guests,
      paymentToken,
      idempotencyKey,
      squareCustomerId,
      origin,
      capacityDeps: serverHeatFreeSpots(origin, ctx.clientKey),
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof DepositPaymentError) {
      return NextResponse.json({ error: err.friendlyMessage, code: err.code }, { status: 402 });
    }
    if (err instanceof AddOnContextError) {
      const status = err.code === "NOT_FOUND" ? 404 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    const message = err instanceof Error ? err.message : "Couldn't add those guests.";
    console.error("[add-on/purchase] error:", err);
    // Capacity / in-progress errors are client-actionable → 409/400; default 500.
    const status = /in progress|can't be added|full|call us|spots left/i.test(message) ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
