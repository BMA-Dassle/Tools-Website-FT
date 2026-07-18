import { NextRequest, NextResponse } from "next/server";
import {
  unifiedReserve,
  RewardFailedError,
  ReserveInProgressError,
  BillExpiredError,
  ExistingBookingConflictError,
} from "~/features/booking/service/unified-reserve";
import {
  DepositPaymentError,
  TerminalPaymentUnverifiedError,
  TerminalAmountMismatchError,
  type ExternalTerminalPayment,
} from "~/features/booking/service/deposit";
import { CreditRedemptionError } from "~/features/booking/service/race-credit-redeem";
import { kioskTerminalEnabled } from "~/features/kiosk/flags";
import { WorldCupReservationError } from "~/features/world-cup";
import type { BookingSession } from "~/features/booking/state/types";
import type { ContactInfo } from "~/features/booking/types";

/**
 * POST /api/booking/v2/reserve-all
 *
 * Thin shell — delegates to unifiedReserve() in the service layer.
 * ONE Square Order, one deposit charge, fans out QAMF + BMI confirmations.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      session: BookingSession;
      contact: ContactInfo;
      cardSourceId?: string;
      giftCardNonce?: string;
      /** PaymentForm source tag — drives the card-vault silent capture. */
      sourceKind?: "card" | "wallet" | "saved" | "gift_card";
      /** Checkout opt-in: keep the captured card permanently. */
      saveCardConsent?: boolean;
      squareCustomerId?: string;
      loyaltyAccountId?: string;
      rewardTierId?: string;
      rewardDiscountCents?: number;
      /** Kiosk direct-Terminal charge (owner: NO saved card). Flag-gated. */
      externalPayment?: ExternalTerminalPayment;
    };

    if (!body.session?.items?.length) {
      return NextResponse.json({ error: "No items in session" }, { status: 400 });
    }
    if (!body.contact?.firstName || !body.contact?.email) {
      return NextResponse.json({ error: "Contact info required" }, { status: 400 });
    }

    // Fail-closed: an externalPayment (kiosk reader charge) is only honored when
    // the terminal flag is on. With the flag off the seam is dormant, so a stale
    // client carrying one is rejected before any money is touched.
    if (body.externalPayment && !kioskTerminalEnabled()) {
      return NextResponse.json({ error: "Terminal payments are not enabled" }, { status: 400 });
    }
    // A request must never carry BOTH a card token and a pre-captured reader
    // payment — reject the ambiguity rather than risk a double charge.
    if (body.externalPayment && body.cardSourceId) {
      return NextResponse.json(
        { error: "Cannot combine a saved card and a terminal payment" },
        { status: 400 },
      );
    }

    const result = await unifiedReserve({
      session: body.session,
      contact: body.contact,
      cardSourceId: body.cardSourceId,
      giftCardNonce: body.giftCardNonce,
      sourceKind: body.sourceKind,
      saveCardConsent: body.saveCardConsent,
      squareCustomerId: body.squareCustomerId,
      loyaltyAccountId: body.loyaltyAccountId,
      rewardTierId: body.rewardTierId,
      rewardDiscountCents: body.rewardDiscountCents,
      externalPayment: body.externalPayment,
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ReserveInProgressError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    }
    if (err instanceof BillExpiredError) {
      // 409 Conflict — the held bill lapsed before payment. No charge happened.
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    }
    if (err instanceof ExistingBookingConflictError) {
      // 409 — a cart heat is too close to one the same racer already booked in
      // another reservation. Raised before any Square write; nothing charged.
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    }
    if (err instanceof WorldCupReservationError) {
      // 409 — a World Cup booking failed the fixture/center validation
      // (disabled center, non-kickoff start, past kickoff). Raised before any
      // Square write; nothing charged.
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    }
    if (err instanceof RewardFailedError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
    }
    if (err instanceof CreditRedemptionError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    if (err instanceof DepositPaymentError) {
      return NextResponse.json({ error: err.friendlyMessage, code: err.code }, { status: 400 });
    }
    if (
      err instanceof TerminalPaymentUnverifiedError ||
      err instanceof TerminalAmountMismatchError
    ) {
      // The reader ALREADY captured the card but the payment failed server-side
      // verification (not COMPLETED / wrong order / amount mismatch). The funds
      // are captured + the paymentId is stamped on the anchor for the reconcile;
      // 500 so it pages on-call. NEVER retried as a fresh charge by the client.
      console.error("[reserve-all] TERMINAL payment verification failed (paging):", err);
      return NextResponse.json(
        {
          error: "Payment needs staff review — please see the front desk.",
          code: "TERMINAL_UNVERIFIED",
        },
        { status: 500 },
      );
    }
    const msg = err instanceof Error ? err.message : "Reservation failed";
    console.error("[reserve-all] error:", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
