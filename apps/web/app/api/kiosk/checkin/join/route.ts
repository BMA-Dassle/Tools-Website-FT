import { NextRequest, NextResponse } from "next/server";
import {
  isCenterSlug,
  readProof,
  loadSummary,
  bindPartyMembers,
} from "~/features/kiosk/checkin/server";
import type { CheckinBindMember, CheckinBindResponse } from "~/features/kiosk/checkin/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/kiosk/checkin/join — attach the added/identified party to the
 * reservation (PR2). Proof-gated: the proof token (minted only after the guest
 * proved possession) carries the billId + center, so the client never sends a
 * raw billId. Neon-first persist, then BMI registerProjectPerson behind the
 * KIOSK_WAIVER_BMI_ATTACH flag. No heat/lane assignment, scheduling, or state
 * change here — those are PR3.
 */
export async function POST(req: NextRequest) {
  let body: {
    center?: string;
    proofToken?: string;
    kioskId?: string;
    members?: CheckinBindMember[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json<CheckinBindResponse>(
      { ok: false, reason: "no-members" },
      { status: 400 },
    );
  }

  const center = String(body.center ?? "");
  if (!isCenterSlug(center)) {
    return NextResponse.json<CheckinBindResponse>(
      { ok: false, error: "Invalid center" },
      { status: 400 },
    );
  }

  const proof = await readProof(String(body.proofToken ?? ""));
  if (!proof || proof.center !== center) {
    return NextResponse.json<CheckinBindResponse>(
      { ok: false, reason: "expired-proof" },
      { status: 401 },
    );
  }

  const members = Array.isArray(body.members) ? body.members : [];
  const ready = members.filter((m) => m && m.bmiPersonId && m.waiverValid);
  if (ready.length === 0) {
    return NextResponse.json<CheckinBindResponse>({ ok: false, reason: "no-members" });
  }

  try {
    // Refuse a cancelled reservation (defense-in-depth; the itinerary already refuses).
    const summary = await loadSummary(proof.billId);
    if (summary?.cancelled) {
      return NextResponse.json<CheckinBindResponse>({ ok: false, reason: "cancelled" });
    }

    const { results } = await bindPartyMembers({
      billId: proof.billId,
      center,
      kioskId: typeof body.kioskId === "string" ? body.kioskId : null,
      verifiedVia: proof.verifiedVia ?? "otp",
      members: ready,
    });

    return NextResponse.json<CheckinBindResponse>({ ok: true, results });
  } catch (err) {
    console.error("[kiosk-checkin] bind failed:", err);
    return NextResponse.json<CheckinBindResponse>(
      { ok: false, error: "Bind failed" },
      { status: 500 },
    );
  }
}
