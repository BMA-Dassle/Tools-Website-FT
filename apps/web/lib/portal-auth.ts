import { NextRequest, NextResponse } from "next/server";
import { isAdminApiRequest } from "./admin-request-auth";

/**
 * The gate for the routes the HeadPinz portal and the daily-events board share
 * (`/api/portal/*`, `/api/admin/daily-events/*`).
 *
 * Two callers, two credentials, one check: the portal integration sends the
 * static admin token in a header, and the board — a staff browser — now sends a
 * signed short-lived one from the same place (2026-08-28 SSO work). The shell's
 * proxy key is accepted too, which is what keeps the board alive after the
 * static token rotates to a machine-only value. See lib/admin-request-auth.
 */
export async function verifyPortal(req: NextRequest): Promise<NextResponse | null> {
  if (await isAdminApiRequest(req)) return null;
  return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
}
