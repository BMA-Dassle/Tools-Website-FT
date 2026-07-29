import { NextRequest, NextResponse } from "next/server";
import { isCenterSlug, readProof, completeCheckin } from "~/features/kiosk/checkin/server";
import type {
  CheckinCompleteResponse,
  CheckinSlotAssignment,
} from "~/features/kiosk/checkin/types";

/** Sanitize the person→slot map: keep only well-shaped {heatId, personId}. */
function parseAssignments(raw: unknown): CheckinSlotAssignment[] {
  if (!Array.isArray(raw)) return [];
  const out: CheckinSlotAssignment[] = [];
  for (const a of raw) {
    if (a && typeof a === "object") {
      const slotKey = (a as { slotKey?: unknown }).slotKey;
      const personId = (a as { personId?: unknown }).personId;
      const category = (a as { category?: unknown }).category;
      if (typeof slotKey === "string" && typeof personId === "string" && slotKey && personId) {
        out.push({
          slotKey,
          personId,
          category: category === "adult" || category === "junior" ? category : null,
        });
      }
    }
  }
  return out;
}

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
  let body: { center?: string; proofToken?: string; kioskId?: string; assignments?: unknown };
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
      assignments: parseAssignments(body.assignments),
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
