import { NextRequest, NextResponse } from "next/server";
import {
  prepareUnifiedDeposit,
  ReserveInProgressError,
  BillExpiredError,
  ExistingBookingConflictError,
} from "~/features/booking/service/unified-reserve";
import { CreditRedemptionError } from "~/features/booking/service/race-credit-redeem";
import { WorldCupReservationError } from "~/features/world-cup";
import { kioskTerminalEnabled } from "~/features/kiosk/flags";
import type { BookingSession } from "~/features/booking/state/types";
import type { ContactInfo } from "~/features/booking/types";

/**
 * POST /api/booking/v2/reserve-prepare — KIOSK direct-Terminal charge only.
 *
 * Runs all pre-charge guards + builds the day-of order(s) + creates the GIFT_CARD
 * deposit order the paired reader will pay, writing a persist-first anchor. The
 * client then charges `depositOrderId` on the reader and calls reserve-all with
 * the completed paymentId. Fail-closed: dormant unless kioskTerminalEnabled().
 * NEVER charges here — the reader does, after this returns.
 */
export async function POST(req: NextRequest) {
  if (!kioskTerminalEnabled()) {
    return NextResponse.json({ error: "Terminal payments are not enabled" }, { status: 400 });
  }
  try {
    const body = (await req.json()) as {
      session: BookingSession;
      contact: ContactInfo;
    };

    if (!body.session?.items?.length) {
      return NextResponse.json({ error: "No items in session" }, { status: 400 });
    }
    if (!body.contact?.firstName || !body.contact?.email) {
      return NextResponse.json({ error: "Contact info required" }, { status: 400 });
    }

    const result = await prepareUnifiedDeposit({
      session: body.session,
      contact: body.contact,
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ReserveInProgressError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    }
    if (err instanceof BillExpiredError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    }
    if (err instanceof ExistingBookingConflictError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    }
    if (err instanceof WorldCupReservationError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    }
    if (err instanceof CreditRedemptionError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    const msg = err instanceof Error ? err.message : "Prepare failed";
    console.error("[reserve-prepare] error:", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
