import { NextRequest, NextResponse } from "next/server";
import { getBowlingReservation } from "@/lib/bowling-db";
import { getCardStatusForReservation, grantPermanentConsent } from "~/features/card-vault";
import { recordAdminAction } from "~/features/reservations-admin/audit";
import { isAdminApiRequest } from "@/lib/admin-request-auth";

/**
 * POST /api/admin/reservations/card-consent?token=...
 *
 * Staff mark the reservation's captured card-on-file as PERMANENT (guest
 * agreed over the phone / at the desk) — the card-vault sweep then never
 * auto-removes it. consent_source records 'admin'.
 *
 * Body: { neonId: number }
 * Auth: ADMIN_CAMERA_TOKEN query param (portal convention).
 */
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!(await isAdminApiRequest(req, { token: token }))) {
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

  const reservation = await getBowlingReservation(neonId);
  if (!reservation) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const card = await getCardStatusForReservation(
    reservation.squareDepositOrderId,
    reservation.squareCustomerId,
  );
  if (!card || !card.squareCardId) {
    return NextResponse.json({ error: "no_card_on_file" }, { status: 409 });
  }
  if (card.disabledAt) {
    return NextResponse.json({ error: "card_already_removed" }, { status: 409 });
  }
  if (card.permanentConsent) {
    return NextResponse.json({ ok: true, alreadyPermanent: true });
  }

  await grantPermanentConsent(card.id);
  await recordAdminAction({
    reservationId: neonId,
    action: "card_consent",
    outcome: "success",
    detail: { cardId: card.squareCardId, last4: card.cardLast4, brand: card.cardBrand },
  });

  return NextResponse.json({ ok: true });
}
