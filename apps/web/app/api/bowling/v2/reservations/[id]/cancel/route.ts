import { NextRequest, NextResponse } from "next/server";
import { CancelGuardError, cancelReservationCascade } from "~/features/cancellation";

/**
 * POST /api/bowling/v2/reservations/[id]/cancel
 *
 * Customer-facing cancellation — a thin shell over the cancellation cascade
 * (~/features/cancellation), which owns the QAMF delete, exactly-once Square
 * refunds, day-of order cancel, BMI add-on cancels, loyalty/promo cleanup,
 * Neon marking, and the guest email+SMS.
 *
 * Body (optional): { outcome?: "store_credit" }
 *   no body / no outcome → refund to card (legacy behavior), ALLOWED only
 *   while NEXT_PUBLIC_BOWLING_CANCEL_CREDIT_ONLY is not "true". When the flag
 *   is on, self-serve refunds return 409 refund_requires_admin and the UI
 *   offers the gift-card path ("prefer a refund? call us").
 *   outcome "store_credit" → the deposit converts to a NEW Square-GAN gift
 *   card, emailed + texted to the guest.
 *
 * Response contract (kept for the existing confirmation page):
 *   200 { ok, refundCents } (+ gan/giftCardId/storeCreditCents for credit)
 *   409 { error: "already cancelled" } · 409 { error: "within_1_hour" }
 *   502 { error: "Refund failed — contact the center for assistance." }
 */

const CREDIT_ONLY = () => process.env.NEXT_PUBLIC_BOWLING_CANCEL_CREDIT_ONLY === "true";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const neonId = parseInt(id, 10);
  if (!neonId || isNaN(neonId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  let outcome: "refund" | "store_credit" = "refund";
  try {
    const body = await req.json();
    if (body?.outcome === "store_credit") outcome = "store_credit";
  } catch {
    // empty body = legacy refund call
  }

  if (outcome === "refund" && CREDIT_ONLY()) {
    return NextResponse.json(
      {
        error: "refund_requires_admin",
        detail: "Card refunds are handled by the center — call us, or choose a gift card.",
      },
      { status: 409 },
    );
  }

  try {
    const result = await cancelReservationCascade({
      neonId,
      outcome,
      actor: "customer",
      dryRun: false,
      allowCustomerRefund: !CREDIT_ONLY(),
    });

    if (result.alreadyCancelled) {
      // Legacy contract: the POST route 409s on a double-cancel.
      return NextResponse.json({ error: "already cancelled" }, { status: 409 });
    }

    return NextResponse.json({
      ok: true,
      refundCents: result.refundCents ?? 0,
      ...(result.storeCredit
        ? {
            gan: result.storeCredit.gan,
            giftCardId: result.storeCredit.giftCardId,
            storeCreditCents: result.storeCredit.amountCents,
            notified: result.notified ?? { email: false, sms: false },
          }
        : {}),
    });
  } catch (err) {
    if (err instanceof CancelGuardError) {
      if (err.code === "within_1_hour") {
        return NextResponse.json({ error: "within_1_hour" }, { status: 409 });
      }
      if (err.code === "not_found") {
        return NextResponse.json({ error: "reservation not found" }, { status: 404 });
      }
      if (err.code === "amount_mismatch" && err.httpStatus === 502) {
        return NextResponse.json(
          { error: "Refund failed — contact the center for assistance." },
          { status: 502 },
        );
      }
      return NextResponse.json(
        { error: err.code, detail: err.message },
        { status: err.httpStatus },
      );
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[bowling/cancel] neonId=${neonId} failed:`, msg);
    return NextResponse.json(
      { error: "Refund failed — contact the center for assistance." },
      { status: 502 },
    );
  }
}
