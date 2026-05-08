import { NextRequest, NextResponse } from "next/server";
import { getFutureKbfReservationByEmail } from "@/lib/bowling-db";

/**
 * GET /api/bowling/v2/my-reservations?email=...
 *
 * Returns the soonest future, non-cancelled KBF reservation for the given
 * email address.  Returns { reservation: null } when none is found.
 *
 * Called by the KBF v2 wizard immediately after 2FA verify to detect
 * duplicate bookings — only one active KBF reservation is allowed at a time.
 * When a reservation is found, the wizard shows it and offers rescheduling
 * instead of starting a fresh booking flow.
 */
export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email");
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "valid email required" }, { status: 400 });
  }
  try {
    const reservation = await getFutureKbfReservationByEmail(email);
    return NextResponse.json({ reservation: reservation ?? null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
