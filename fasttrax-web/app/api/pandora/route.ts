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
      `${PANDORA_URL}/bmi/person/${LOCATION_ID}/${personId}?picture=false&allRelated=true`,
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
      birthdate: person.birthdate || null,
      waiverExpiry: person.waiverExpiry,
      lastVisit: person.lastVisit,
      related: person.related || [],
    });
  } catch {
    return NextResponse.json({ valid: false, personId, reason: "API error" });
  }
}

/** Create a new person in BMI via Pandora */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { firstName, lastName, email, phone, birthdate, guardianID } = body;

    if (!firstName || !lastName) {
      return NextResponse.json({ error: "firstName and lastName required" }, { status: 400 });
    }

    const payload: Record<string, string> = {
      locationID: LOCATION_ID,
      firstName,
      lastName,
    };
    if (email) payload.email = email;
    if (phone) payload.phoneNumber = phone.replace(/\D/g, "");
    if (birthdate) payload.birthdate = birthdate;
    if (guardianID) payload.guardianID = guardianID;

    const res = await fetch(`${PANDORA_URL}/bmi/person`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      return NextResponse.json({ error: data.message || "Failed to create person" }, { status: res.status || 500 });
    }

    return NextResponse.json({ personId: data.data.personID });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Pandora API error" }, { status: 500 });
  }
}
