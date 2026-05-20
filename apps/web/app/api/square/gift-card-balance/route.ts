import { NextRequest, NextResponse } from "next/server";
import { retrieveGiftCardFromNonce } from "@/lib/square-gift-card";

/**
 * POST /api/square/gift-card-balance
 *
 * Looks up a Square gift card from a Web Payments SDK nonce and
 * returns the current balance. UX nicety so the checkout can show
 * "$X applied, $Y remaining on card" before the customer enters a
 * card. The real authorization happens in /api/square/pay or
 * /api/square/bowling-orders, which both re-validate the GAN and
 * block internal deposit cards independently — this endpoint is not
 * a security boundary.
 *
 * Request: { nonce: string }
 * Response:
 *   200 { balanceCents, gan, last4, state }
 *   200 { blocked: true, reason: "internal" | "inactive" | "zero-balance", message }
 *   400 { error } — bad/missing nonce
 *   500 { error } — Square API failure
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const nonce: unknown = body?.nonce;
    if (!nonce || typeof nonce !== "string") {
      return NextResponse.json({ error: "nonce required" }, { status: 400 });
    }

    const info = await retrieveGiftCardFromNonce(nonce);
    if (!info) {
      return NextResponse.json(
        { error: "Gift card could not be found. Please re-enter the gift card number." },
        { status: 400 },
      );
    }

    if (info.blocked) {
      return NextResponse.json({
        blocked: true,
        reason: "internal" as const,
        message: "This gift card type cannot be used online.",
      });
    }

    if (info.state !== "ACTIVE") {
      return NextResponse.json({
        blocked: true,
        reason: "inactive" as const,
        message: "This gift card is not active.",
      });
    }

    if (info.balanceCents <= 0) {
      return NextResponse.json({
        blocked: true,
        reason: "zero-balance" as const,
        message: "This gift card has no balance.",
      });
    }

    return NextResponse.json({
      balanceCents: info.balanceCents,
      gan: info.gan,
      last4: info.gan.slice(-4),
      state: info.state,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Gift card lookup failed";
    console.error("[gift-card-balance] error:", msg);
    return NextResponse.json({ error: "Could not look up gift card." }, { status: 500 });
  }
}
