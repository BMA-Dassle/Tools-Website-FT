import { NextRequest, NextResponse } from "next/server";
import {
  unifiedReserve,
  RewardFailedError,
  ReserveInProgressError,
  BillExpiredError,
} from "~/features/booking/service/unified-reserve";
import { DepositPaymentError } from "~/features/booking/service/deposit";
import { CreditRedemptionError } from "~/features/booking/service/race-credit-redeem";
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
      squareCustomerId?: string;
      loyaltyAccountId?: string;
      rewardTierId?: string;
      rewardDiscountCents?: number;
    };

    if (!body.session?.items?.length) {
      return NextResponse.json({ error: "No items in session" }, { status: 400 });
    }
    if (!body.contact?.firstName || !body.contact?.email) {
      return NextResponse.json({ error: "Contact info required" }, { status: 400 });
    }

    const result = await unifiedReserve({
      session: body.session,
      contact: body.contact,
      cardSourceId: body.cardSourceId,
      giftCardNonce: body.giftCardNonce,
      squareCustomerId: body.squareCustomerId,
      loyaltyAccountId: body.loyaltyAccountId,
      rewardTierId: body.rewardTierId,
      rewardDiscountCents: body.rewardDiscountCents,
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
    if (err instanceof RewardFailedError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
    }
    if (err instanceof CreditRedemptionError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    if (err instanceof DepositPaymentError) {
      return NextResponse.json({ error: err.friendlyMessage, code: err.code }, { status: 400 });
    }
    const msg = err instanceof Error ? err.message : "Reservation failed";
    console.error("[reserve-all] error:", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
