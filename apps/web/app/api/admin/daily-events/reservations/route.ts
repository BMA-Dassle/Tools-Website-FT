import { NextRequest, NextResponse } from "next/server";
import { verifyPortal } from "@/lib/portal-auth";
import { listQuerySchema } from "~/features/daily-events/schemas";
import { listDailyEvents } from "~/features/daily-events/service";
import { OfficeApiError } from "~/features/daily-events/data/bmi-office";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/daily-events/reservations?token=...&locationId=332160&date=YYYY-MM-DD
 *
 * Day list of BMI group-event reservations — port of the employee portal's
 * /api/integrations/sms-timing-reservations (same upstream calls, same
 * response shape). Auth: ADMIN_CAMERA_TOKEN (?token= or x-admin-token),
 * plus the /api/admin middleware gate.
 */
export async function GET(req: NextRequest) {
  const denied = verifyPortal(req);
  if (denied) return denied;

  const parsed = listQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message || "Invalid query" },
      { status: 400 },
    );
  }

  try {
    const data = await listDailyEvents(
      parsed.data.locationId,
      parsed.data.date,
      parsed.data.includeAll === "true",
    );
    return NextResponse.json({ success: true, data });
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
