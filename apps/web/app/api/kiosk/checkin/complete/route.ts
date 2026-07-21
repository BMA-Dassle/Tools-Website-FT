import { NextRequest, NextResponse } from "next/server";
import { isCenterSlug, readProof, completeCheckin } from "~/features/kiosk/checkin/server";
import type { CheckinCompleteResponse } from "~/features/kiosk/checkin/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/kiosk/checkin/complete — "check in everyone" (PR3 finalize).
 * Proof-gated. Assigns the added party to open heats, schedules them onto the
 * Pandora session, stamps the BMI project -5 "Arrived", and writes the staff
 * memo (all behind KIOSK_CHECKIN_ATTACH, default OFF). Idempotent per
 * (bill, business day) via the check-in event; single-flight-locked per bill.
 */
export async function POST(req: NextRequest) {
  let body: { center?: string; proofToken?: string; kioskId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json<CheckinCompleteResponse>(
      { ok: false, error: "invalid body" },
      { status: 400 },
    );
  }

  const center = String(body.center ?? "");
  if (!isCenterSlug(center)) {
    return NextResponse.json<CheckinCompleteResponse>(
      { ok: false, error: "Invalid center" },
      { status: 400 },
    );
  }

  const proof = await readProof(String(body.proofToken ?? ""));
  if (!proof || proof.center !== center) {
    return NextResponse.json<CheckinCompleteResponse>(
      { ok: false, reason: "expired-proof" },
      { status: 401 },
    );
  }

  try {
    const result = await completeCheckin({
      billId: proof.billId,
      center,
      kioskId: typeof body.kioskId === "string" ? body.kioskId : null,
      verifiedVia: proof.verifiedVia ?? "otp",
    });
    const status = result.reason === "busy" ? 409 : 200;
    return NextResponse.json<CheckinCompleteResponse>(result, { status });
  } catch (err) {
    console.error("[kiosk-checkin] complete failed:", err);
    return NextResponse.json<CheckinCompleteResponse>(
      { ok: false, error: "Check-in failed" },
      { status: 500 },
    );
  }
}
