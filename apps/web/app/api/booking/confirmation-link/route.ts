import { NextRequest, NextResponse } from "next/server";
import { confirmationShortUrl } from "@/lib/booking-confirmation-link";

export const dynamic = "force-dynamic";

/**
 * GET /api/booking/confirmation-link?billId=...&v2=1
 *
 * Returns the canonical short confirmation link (`${SITE_URL}/s/{code}`) for a
 * bill, minting + storing it idempotently. Used by the client-side BMI memo
 * composer and the admin reservations board so their links match the one the
 * customer gets by email/SMS.
 *
 * Only input is the billId — the link just points at a confirmation page that
 * already requires the billId + signature, so this adds no new exposure.
 *
 * billId is a 17-digit bigint: read it as a raw string, never Number() it.
 */
export async function GET(req: NextRequest) {
  const billId = req.nextUrl.searchParams.get("billId");
  if (!billId || !/^\d+$/.test(billId)) {
    return NextResponse.json({ error: "billId required" }, { status: 400 });
  }
  const v2 = req.nextUrl.searchParams.get("v2") === "1";
  try {
    const shortUrl = await confirmationShortUrl(billId, v2);
    return NextResponse.json({ shortUrl });
  } catch (err) {
    console.error("[booking/confirmation-link]", err);
    return NextResponse.json({ error: "Failed to build link" }, { status: 500 });
  }
}
