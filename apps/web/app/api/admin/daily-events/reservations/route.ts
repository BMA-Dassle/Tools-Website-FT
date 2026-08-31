import { NextRequest, NextResponse } from "next/server";
import { verifyPortal } from "@/lib/portal-auth";
import redis from "@/lib/redis";
import { listQuerySchema } from "~/features/daily-events/schemas";
import { listDailyEvents } from "~/features/daily-events/service";
import { OfficeApiError } from "~/features/daily-events/data/bmi-office";

export const dynamic = "force-dynamic";

// Cache: each date is otherwise a live BMI liveReservations call plus a
// project GET per waiver event. The daily-events-cache-warm cron re-warms
// today−1…+13 for all locations every 5 minutes, so the TTL must outlive
// the cron period; board hits inside that window are ~0.1s. Redis outage
// is non-fatal — falls through to BMI.
const CACHE_TTL_SECONDS = 360;

/**
 * GET /api/admin/daily-events/reservations?token=...&locationId=332160&date=YYYY-MM-DD
 *
 * Day list of BMI group-event reservations — port of the employee portal's
 * /api/integrations/sms-timing-reservations (same upstream calls, same
 * response shape). Auth: ADMIN_CAMERA_TOKEN (?token= or x-admin-token),
 * plus the /api/admin middleware gate.
 */
export async function GET(req: NextRequest) {
  const denied = await verifyPortal(req);
  if (denied) return denied;

  const parsed = listQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message || "Invalid query" },
      { status: 400 },
    );
  }

  const cacheKey = `de:res:${parsed.data.locationId}:${parsed.data.date}:${parsed.data.includeAll === "true" ? 1 : 0}`;
  try {
    const cached = await redis.get(cacheKey).catch(() => null);
    if (typeof cached === "string" && cached) {
      return new NextResponse(cached, {
        status: 200,
        headers: { "content-type": "application/json", "x-de-cache": "hit" },
      });
    }

    const data = await listDailyEvents(
      parsed.data.locationId,
      parsed.data.date,
      parsed.data.includeAll === "true",
    );
    const body = JSON.stringify({ success: true, data });
    redis.setex(cacheKey, CACHE_TTL_SECONDS, body).catch(() => {});
    return new NextResponse(body, {
      status: 200,
      headers: { "content-type": "application/json", "x-de-cache": "miss" },
    });
  } catch (error) {
    console.error("[daily-events] reservations error:", error);
    if (error instanceof OfficeApiError) {
      return NextResponse.json(
        { success: false, error: "Failed to fetch reservations" },
        { status: error.status >= 500 ? 502 : error.status },
      );
    }
    return NextResponse.json(
      {
        success: false,
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
