import { NextRequest, NextResponse } from "next/server";
import { listGfQuotes } from "@/lib/group-function-db";

/**
 * GET /api/admin/group-functions/pending-approvals?token=...
 *
 * Returns all group function quotes awaiting management approval (post-paid accounts).
 */

const ADMIN_TOKEN = process.env.ADMIN_CAMERA_TOKEN || "";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") || "";
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const quotes = await listGfQuotes({ status: "pending_approval", limit: 100 });

    return NextResponse.json({
      ok: true,
      count: quotes.length,
      quotes: quotes.map((q) => ({
        id: q.id,
        contractShortId: q.contract_short_id,
        reservationId: q.bmi_reservation_id,
        centerName: q.center_name,
        centerCode: q.center_code,
        brand: q.brand,
        eventName: q.event_name,
        eventNumber: q.event_number,
        eventDate: q.event_date,
        eventDateDisplay: q.event_date_display,
        guestName: `${q.guest_first_name} ${q.guest_last_name}`,
        guestEmail: q.guest_email,
        guestPhone: q.guest_phone,
        plannerName: q.planner_first ? `${q.planner_first} ${q.planner_last || ""}`.trim() : null,
        plannerEmail: q.planner_email,
        plannerPhone: q.planner_phone,
        notes: q.notes,
        totalCents: q.total_cents,
        taxCents: q.tax_cents,
        depositDueCents: q.deposit_due_cents,
        balanceCents: q.balance_cents,
        lineItems: q.line_items,
        createdAt: q.created_at,
        approveUrl: `${q.base_url}/api/group-function/approve`,
      })),
    });
  } catch (err) {
    console.error("[admin/pending-approvals] Error:", err);
    return NextResponse.json({ error: "Failed to load pending approvals" }, { status: 500 });
  }
}
