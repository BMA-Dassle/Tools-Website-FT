import { NextRequest, NextResponse } from "next/server";
import { isCenterSlug, readProof, buildItinerary } from "~/features/kiosk/checkin/server";
import type { CheckinItinerary } from "~/features/kiosk/checkin/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/kiosk/checkin/itinerary?proof={token}&center={slug}
 *
 * Proof-gated "what's next" envelope. The proof token is minted only after the
 * guest proved possession (scan / phone-OTP / contact-OTP) and is bound to one
 * billId — so this is the only surface that returns names + contact-derived
 * data, and only for a reservation the guest demonstrably holds.
 */
export async function GET(req: NextRequest) {
  const proof = req.nextUrl.searchParams.get("proof") ?? "";
  const center = req.nextUrl.searchParams.get("center") ?? "";

  if (!isCenterSlug(center)) {
    return NextResponse.json({ ok: false, reason: "expired-proof" }, { status: 400 });
  }
  const resolved = await readProof(proof);
  if (!resolved || resolved.center !== center) {
    return NextResponse.json<CheckinItinerary>(
      {
        ok: false,
        reservationNumber: null,
        center,
        firstName: "",
        activities: [],
        firstStop: null,
        roster: [],
        dueAtCenterCents: 0,
        reason: "expired-proof",
      },
      { status: 401 },
    );
  }

  const itinerary = await buildItinerary(resolved.billId, center);
  // not-found / cancelled are legitimate 200 results (the client reads `reason`);
  // only a bad/expired proof is a 401 (handled above).
  return NextResponse.json<CheckinItinerary>(itinerary, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
