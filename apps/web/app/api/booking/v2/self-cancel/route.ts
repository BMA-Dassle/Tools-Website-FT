import { NextRequest, NextResponse } from "next/server";
import { verifyBillSignature } from "@/lib/booking-confirmation-link";
import { getBowlingReservationByBillId } from "@/lib/bowling-db";
import { CancelGuardError, cancelReservationCascade } from "~/features/cancellation";

// Store-credit issuance + teardown + BMI state verification (Pandora writes
// can take ~25s to become visible) can exceed the default function window.
export const maxDuration = 60;

/**
 * POST /api/booking/v2/self-cancel
 *
 * Guest self-serve cancel from the v2 confirmation page — STORE CREDIT ONLY
 * (card refunds are staff-only; combos are staff-only entirely). Cancels the
 * WHOLE booking: every reservation row sharing the bill's deposit (mixed
 * race+attraction carts cancel together — one deposit funds them all), and
 * issues one gift card for the full amount, emailed + texted to the guest.
 *
 * Body: { billId: string, sig: string }
 *   sig = the same HMAC that signs the confirmation URL the guest is on
 *   (billId stays a RAW string — 17-digit BMI id).
 *
 * Errors: 403 bad sig · 404 unknown bill · 409 within_1_hour /
 * nothing_to_credit / dayof_order_tendered / already handled ·
 * 422 combo_call_center.
 */
export async function POST(req: NextRequest) {
  let body: { billId?: unknown; sig?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const billId = typeof body.billId === "string" ? body.billId.trim() : "";
  const sig = typeof body.sig === "string" ? body.sig.trim() : "";
  if (!billId || !sig) {
    return NextResponse.json({ error: "billId and sig required" }, { status: 400 });
  }
  if (!verifyBillSignature(billId, sig)) {
    return NextResponse.json({ error: "bad signature" }, { status: 403 });
  }

  const anchor = await getBowlingReservationByBillId(billId);
  if (!anchor) {
    return NextResponse.json({ error: "booking not found" }, { status: 404 });
  }

  try {
    const result = await cancelReservationCascade({
      neonId: anchor.id,
      outcome: "store_credit",
      actor: "customer",
      dryRun: false,
    });
    return NextResponse.json({
      ok: true,
      alreadyCancelled: result.alreadyCancelled ?? false,
      gan: result.storeCredit?.gan ?? null,
      giftCardId: result.storeCredit?.giftCardId ?? null,
      amountCents: result.storeCredit?.amountCents ?? result.amountCents,
      notified: result.notified ?? { email: false, sms: false },
    });
  } catch (err) {
    if (err instanceof CancelGuardError) {
      if (err.code === "combo_requires_admin") {
        return NextResponse.json(
          { error: "combo_call_center", detail: err.message },
          { status: 422 },
        );
      }
      return NextResponse.json(
        { error: err.code, detail: err.message },
        { status: err.httpStatus },
      );
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[booking/self-cancel] bill=${billId} failed:`, msg);
    return NextResponse.json(
      { error: "cancel_failed", detail: "Something went wrong and no changes were made." },
      { status: 502 },
    );
  }
}
