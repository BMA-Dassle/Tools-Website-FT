import { NextRequest, NextResponse } from "next/server";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";
const LOCATION_ID = process.env.SQUARE_FT_LOCATION_ID || "TXBSQN0FEKQ11";

/**
 * Link racers/participants to a reservation schedule in BMI.
 * Called after payment confirmation to populate the race/activity schedule.
 *
 * POST body: { resNumber: "W23905", racers: [...] }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { resNumber, racers } = body;

    if (!resNumber || !racers || !Array.isArray(racers) || racers.length === 0) {
      return NextResponse.json({ error: "resNumber and racers[] required" }, { status: 400 });
    }

    const res = await fetch(`${PANDORA_URL}/bmi/schedule/${LOCATION_ID}/${resNumber}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ racers }),
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      console.error("[pandora/schedule] error:", res.status, data);
      return NextResponse.json({ error: data.message || "Failed to link racers" }, { status: res.status || 500 });
    }

    console.log(`[pandora/schedule] ${resNumber}: linked ${data.data?.inserted || 0} racers`);
    return NextResponse.json({ ok: true, inserted: data.data?.inserted || 0 });
  } catch (err) {
    console.error("[pandora/schedule] error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Schedule API error" }, { status: 500 });
  }
}
