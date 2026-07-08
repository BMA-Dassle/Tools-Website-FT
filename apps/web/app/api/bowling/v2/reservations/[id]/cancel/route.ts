import { NextRequest, NextResponse } from "next/server";
import { CancelGuardError, cancelReservationCascade } from "~/features/cancellation";

// Store-credit issuance + teardown + BMI state verification (Pandora writes
// can take ~25s to become visible) can exceed the default function window.
export const maxDuration = 60;

/**
 * POST /api/bowling/v2/reservations/[id]/cancel
 *
 * Customer-facing cancellation — a thin shell over the cancellation cascade
 * (~/features/cancellation), which owns the QAMF delete, exactly-once Square
 * refunds, day-of order cancel, BMI add-on cancels, loyalty/promo cleanup,
 * Neon marking, and the guest email+SMS.
 *
 * Owner policy 2026-07-03 (live, no flag): self-serve settles as a HeadPinz
 * FastTrax Gift Card — card refunds are staff/phone-only. A legacy no-body
 * call (stale bundle asking for the old refund) gets 409
 * refund_requires_admin with the call-us copy rather than silently receiving
 * a gift card it didn't ask for.
 *
 * Body: { outcome: "store_credit" } → the deposit converts to a NEW
 * Square-GAN HeadPinz FastTrax Gift Card, emailed + texted to the guest.
 *
 * Response contract (kept for the existing confirmation page):
 *   200 { ok, refundCents } (+ gan/giftCardId/storeCreditCents for credit)
 *   409 { error: "already cancelled" } · 409 { error: "within_1_hour" }
 *   502 { error: "Refund failed — contact the center for assistance." }
 */
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

  if (outcome === "refund") {
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
