import { NextRequest, NextResponse } from "next/server";
import { verifyPortal } from "@/lib/portal-auth";
import { detailQuerySchema, projectIdSchema } from "~/features/daily-events/schemas";
import { getReservationDetail } from "~/features/daily-events/service";
import { OfficeApiError } from "~/features/daily-events/data/bmi-office";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/daily-events/reservations/{projectId}?token=...&locationId=332160
 *
 * Full reservation detail — port of the employee portal's
 * /api/integrations/sms-timing-reservation-detail, plus website-native
 * contract info (replaces the portal's PandaDoc section).
 *
 * projectId is a 17-digit BMI id — validated as a digit STRING, never
 * passed through Number().
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const denied = await verifyPortal(req);
  if (denied) return denied;

  const { projectId } = await params;
  const idParsed = projectIdSchema.safeParse(projectId);
  if (!idParsed.success) {
    return NextResponse.json({ success: false, error: "Invalid projectId" }, { status: 400 });
  }

  const parsed = detailQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message || "Invalid query" },
      { status: 400 },
    );
  }

  try {
    const data = await getReservationDetail(parsed.data.locationId, idParsed.data);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("[daily-events] reservation detail error:", error);
    if (error instanceof OfficeApiError) {
      const status = error.status >= 500 ? 502 : error.status === 404 ? 404 : error.status;
      return NextResponse.json(
        { success: false, error: "Failed to fetch reservation detail" },
        { status },
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
