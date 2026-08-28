import { NextRequest, NextResponse } from "next/server";
import { paymentsQuerySchema } from "~/features/reservations-admin/schemas";
import { getPaymentTimeline } from "~/features/reservations-admin/service";
import { isAdminApiRequest } from "@/lib/admin-request-auth";

/**
 * GET /api/admin/reservations/detail/payments?token=…&id=<neonId>
 *
 * Live Square payment timeline for the reservation's whole money group:
 * deposit order + tender payment statuses → funding gift card → per-leg
 * day-of order(s) → store-credit outcome. 3–8 Square reads — fetched only
 * when the Payments tab activates. Each node fails independently
 * (node.error) so one flaky read never blanks the timeline.
 *
 * Auth: ADMIN_CAMERA_TOKEN query param (portal convention).
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!(await isAdminApiRequest(req, { token: token }))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = paymentsQuerySchema.safeParse({
    id: req.nextUrl.searchParams.get("id") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  try {
    const timeline = await getPaymentTimeline(parsed.data.id);
    if (!timeline) {
      return NextResponse.json({ error: "reservation not found" }, { status: 404 });
    }
    return NextResponse.json(timeline);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[admin/reservations/detail/payments]`, msg);
    return NextResponse.json({ error: "payments_failed", detail: msg }, { status: 500 });
  }
}
