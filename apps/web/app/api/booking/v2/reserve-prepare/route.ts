import { NextRequest, NextResponse } from "next/server";
import {
  prepareUnifiedDeposit,
  ReserveInProgressError,
  BillExpiredError,
  ExistingBookingConflictError,
  CrossCategoryHeatCollisionError,
} from "~/features/booking/service/unified-reserve";
import { CreditRedemptionError } from "~/features/booking/service/race-credit-redeem";
import {
  RaceSimNotConfiguredError,
  RaceSimMixedCartError,
  RaceSimStaleHoldError,
} from "~/features/race-sims/products";
import { WorldCupReservationError } from "~/features/world-cup";
import type { BookingSession } from "~/features/booking/state/types";
import type { ContactInfo } from "~/features/booking/types";
import { setSplitSession } from "~/features/kiosk/data/split-tenders-db";

/**
 * POST /api/booking/v2/reserve-prepare — KIOSK direct-Terminal charge only.
 *
 * Runs all pre-charge guards + builds the day-of order(s) + creates the GIFT_CARD
 * deposit order the paired reader will pay, writing a persist-first anchor. The
 * client then charges `depositOrderId` on the reader and calls reserve-all with
 * the completed paymentId.
 * NEVER charges here — the reader does, after this returns.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      session: BookingSession;
      contact: ContactInfo;
      /** What the review screen showed — logged against the server total. */
      expectedCents?: number;
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
      expectedCents: typeof body.expectedCents === "number" ? body.expectedCents : undefined,
    });

    // Persist the session server-side (2026-08-10, W59702): completing a paid
    // booking must never depend on the kiosk tab surviving the seconds after
    // capture. With the session on the ledger row, the capture observer
    // (terminal-checkout) finishes the reservation itself if the client never
    // calls reserve-all. Best-effort — a write failure never blocks the reader.
    if (result?.seed) {
      void setSplitSession(result.seed, body.session, body.contact);
    }

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
    if (err instanceof CrossCategoryHeatCollisionError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    }
    if (err instanceof WorldCupReservationError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    }
    if (
      err instanceof RaceSimNotConfiguredError ||
      err instanceof RaceSimMixedCartError ||
      err instanceof RaceSimStaleHoldError
    ) {
      // 409 — Race Sims guard 2e (keys not armed, or sims mixed with HeadPinz
      // items): refused before the day-of order exists, reader never armed.
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
