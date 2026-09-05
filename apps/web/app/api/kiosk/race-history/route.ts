import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readStaffAccount } from "~/features/kiosk/staff-mode/service.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kiosk GUEST race-history API — a racer's own account, READ-ONLY (owner
 * 2026-09-05: staff already see this on the crew roster, "we might as well
 * show it to the racer" — plus their credits by kind).
 *
 * No staff token ON PURPOSE: this is the guest's own data, reached from the
 * Your Crew roster after they signed in on the kiosk (OTP / licence scan /
 * member QR). Authorization follows the existing guest person-read precedent
 * (/api/pandora?personId=…): the personId is the capability — ids are only
 * obtained by signing in, and nothing here writes. The guest view is a SUBSET
 * of the staff account read: heats + summary + credits + licence; memberships
 * (kind ids, windows) stay on the staff-token-gated route.
 */

const ID_RE = /^\d{1,20}$/;
const LocationSchema = z.enum(["fasttrax", "headpinz", "naples"]);

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const personId = searchParams.get("personId") || "";
  const location = LocationSchema.safeParse(searchParams.get("location"));
  if (!ID_RE.test(personId) || !location.success) {
    return NextResponse.json({ error: "personId + location required" }, { status: 400 });
  }
  const account = await readStaffAccount(personId, location.data);
  return NextResponse.json({
    licenseActive: account.licenseActive,
    credits: account.credits,
    heats: account.heats,
    summary: account.summary,
  });
}
