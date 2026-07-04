import { NextRequest, NextResponse } from "next/server";
import { verifyBillSignature } from "@/lib/booking-confirmation-link";
import { getBowlingReservationByBillId, listCancelGroupReservations } from "@/lib/bowling-db";

/**
 * GET /api/booking/v2/booking-status?billId=…&sig=…
 *
 * Lifecycle state for a v2 confirmation page: is this booking cancelled, and
 * how did it settle? The confirmation page renders from BMI/Square/Redis
 * snapshots that predate any cancellation, so without this it happily says
 * "You're booked!" forever. Resolves the whole MONEY GROUP (combo legs, mixed
 * carts) — the group cancels together, so the page reports cancelled only
 * when every leg is.
 *
 * Auth: the same HMAC bill signature that authorizes the page itself (the
 * response carries the gift-card GAN, so possession of the signed link is
 * required — same bar as self-cancel).
 *
 * Response: { found, cancelled, outcome?, refundCents?, storeCredit? } —
 * best-effort; any failure returns { found: false } and the page just renders
 * as before.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const billId = (params.get("billId") || "").trim();
  const sig = (params.get("sig") || "").trim();
  if (!billId || !sig) {
    return NextResponse.json({ found: false, error: "billId and sig required" }, { status: 400 });
  }
  if (!verifyBillSignature(billId, sig)) {
    return NextResponse.json({ found: false, error: "bad signature" }, { status: 403 });
  }

  try {
    const anchor = await getBowlingReservationByBillId(billId);
    if (!anchor) return NextResponse.json({ found: false });

    const legs = await listCancelGroupReservations(anchor);
    const cancelled = legs.length > 0 && legs.every((l) => l.status === "cancelled");
    if (!cancelled) {
      return NextResponse.json({ found: true, cancelled: false });
    }

    // The settlement is stamped on every leg (mirrored); read it off whichever
    // leg carries it.
    const money =
      legs.find((l) => l.storeCreditGiftCardGan || l.refundCents > 0 || l.cancellationOutcome) ??
      anchor;
    const storeCredit =
      money.storeCreditGiftCardGan && money.storeCreditCents > 0
        ? {
            gan: money.storeCreditGiftCardGan,
            giftCardId: money.storeCreditGiftCardId ?? null,
            amountCents: money.storeCreditCents,
          }
        : null;

    return NextResponse.json({
      found: true,
      cancelled: true,
      outcome:
        money.cancellationOutcome ??
        (storeCredit ? "store_credit" : money.refundCents > 0 ? "refund" : "none"),
      refundCents: money.refundCents ?? 0,
      storeCredit,
    });
  } catch (err) {
    console.warn("[booking/v2/booking-status] failed:", err);
    return NextResponse.json({ found: false });
  }
}
