import { NextRequest, NextResponse } from "next/server";
import { getBowlingReservation, listCancelGroupReservations } from "@/lib/bowling-db";
import { sendCancellationNotifications } from "~/features/cancellation";

/**
 * POST /api/notifications/cancellation?token=...
 *
 * Admin resend of a cancellation notice (refund confirmation or the
 * store-credit gift card email+SMS). Everything derives from the Neon rows —
 * the cascade already persisted the outcome + GAN, so a resend needs only the
 * neonId. Skips the Redis dedupe via forceResend.
 *
 * Body: { neonId: number }
 * Auth: ADMIN_CAMERA_TOKEN query param (staff-only — this can message guests).
 */
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { neonId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const neonId = typeof body.neonId === "number" ? body.neonId : parseInt(String(body.neonId), 10);
  if (!neonId || Number.isNaN(neonId)) {
    return NextResponse.json({ error: "neonId required" }, { status: 400 });
  }

  const anchor = await getBowlingReservation(neonId);
  if (!anchor) {
    return NextResponse.json({ error: "reservation not found" }, { status: 404 });
  }
  if (anchor.status !== "cancelled") {
    return NextResponse.json({ error: "reservation is not cancelled" }, { status: 409 });
  }

  const legs = await listCancelGroupReservations(anchor);
  const money = legs.find((l) => l.refundCents > 0 || l.storeCreditGiftCardGan) ?? anchor;
  const outcome =
    money.cancellationOutcome ?? (money.storeCreditGiftCardGan ? "store_credit" : "refund");

  const notified = await sendCancellationNotifications({
    anchor: money,
    legs,
    outcome,
    amountCents: outcome === "store_credit" ? money.storeCreditCents : money.refundCents,
    storeCredit: money.storeCreditGiftCardGan
      ? {
          giftCardId: money.storeCreditGiftCardId ?? "",
          gan: money.storeCreditGiftCardGan,
          amountCents: money.storeCreditCents,
        }
      : undefined,
    forceResend: true,
  });

  return NextResponse.json({ ok: true, notified });
}
