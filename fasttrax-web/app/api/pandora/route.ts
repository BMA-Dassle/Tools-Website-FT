import { NextRequest, NextResponse } from "next/server";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";
const LOCATION_ID = process.env.SQUARE_FT_LOCATION_ID || "TXBSQN0FEKQ11";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const personId = searchParams.get("personId");

  if (!personId) {
    return NextResponse.json({ error: "Missing personId" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `${PANDORA_URL}/bmi/person/${LOCATION_ID}/${personId}?picture=false`,
      {
        headers: { "Authorization": `Bearer ${API_KEY}` },
        cache: "no-store",
      },
    );

    const data = await res.json();

    if (!res.ok || !data.success) {
      // Person not found or error — assume no valid waiver
      return NextResponse.json({
        valid: false,
        personId,
        reason: data.message || "Not found",
      });
    }

    const person = data.data;
    const waiverExpiry = person.waiverExpiry ? new Date(person.waiverExpiry) : null;
    const isValid = waiverExpiry ? waiverExpiry > new Date() : false;

    return NextResponse.json({
      valid: isValid,
      personId,
      firstName: person.firstName,
      lastName: person.lastName,
      waiverExpiry: person.waiverExpiry,
      lastVisit: person.lastVisit,
      related: person.related || [],
    });
  } catch {
    return NextResponse.json({ valid: false, personId, reason: "API error" });
  }
}
