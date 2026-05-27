import { NextRequest, NextResponse } from "next/server";
import { listGfQuotes, type GfQuoteStatus } from "@/lib/group-function-db";

/**
 * Admin: list group function quotes.
 *
 * GET /api/admin/group-functions?token=...&status=...&limit=...
 */

const ADMIN_TOKEN = process.env.ADMIN_CAMERA_TOKEN || "";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") || "";
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = (req.nextUrl.searchParams.get("status") as GfQuoteStatus) || undefined;
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || "50"), 200);

  try {
    const quotes = await listGfQuotes({ status, limit });
    return NextResponse.json({
      ok: true,
      count: quotes.length,
      quotes: quotes.map((q) => ({
        id: q.id,
        reservationId: q.bmi_reservation_id,
        centerName: q.center_name,
        centerCode: q.center_code,
        eventName: q.event_name,
        eventNumber: q.event_number,
        eventDate: q.event_date,
        eventDateDisplay: q.event_date_display,
        guestName: `${q.guest_first_name} ${q.guest_last_name}`,
        guestEmail: q.guest_email,
        guestPhone: q.guest_phone,
        plannerName: q.planner_first ? `${q.planner_first} ${q.planner_last || ""}` : null,
        status: q.status,
        contractShortId: q.contract_short_id,
        contractStatus: q.contract_status,
        totalCents: q.total_cents,
        depositDueCents: q.deposit_due_cents,
        balanceCents: q.balance_cents,
        giftCardGan: q.square_gift_card_gan,
        squareDayofOrderId: q.square_dayof_order_id,
        depositPaidAt: q.deposit_paid_at,
        balancePaidAt: q.balance_paid_at,
        balancePaymentMethod: q.balance_payment_method,
        balancePaymentLinkUrl: q.balance_payment_link_url,
        createdAt: q.created_at,
      })),
    });
  } catch (err) {
    console.error("[admin/group-functions] Error:", err);
    return NextResponse.json({ error: "Failed to load quotes" }, { status: 500 });
  }
}
