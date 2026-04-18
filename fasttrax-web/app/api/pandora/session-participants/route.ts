import { NextRequest, NextResponse } from "next/server";

/**
 * Proxy for Pandora's session-participants endpoint.
 *
 *   GET /api/pandora/session-participants?locationId=LAB52GY480CJF&sessionId=41781713
 *
 * Upstream: GET /bmi/session/{locationID}/{sessionId}/participants
 *
 * Response: { success, message, data: [{ personId, firstName, lastName, email, phone }] }
 *
 * No caching — rosters change in real time as racers are added/removed, and
 * stale cache was causing the pre-race cron to miss fresh participants and
 * send single-ticket SMS where a grouped one was correct.
 */

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";

const ALLOWED_LOCATIONS = new Set([
  "LAB52GY480CJF", // FastTrax
  "TXBSQN0FEKQ11", // HeadPinz Fort Myers
  "PPTR5G2N0QXF7", // HeadPinz Naples
]);

// The upstream shape — re-export our shared canonical type for consumers.
export type { Participant } from "@/lib/participant-contact";
import type { Participant } from "@/lib/participant-contact";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const locationId = searchParams.get("locationId");
  const sessionId = searchParams.get("sessionId");

  if (!locationId || !ALLOWED_LOCATIONS.has(locationId)) {
    return NextResponse.json({ error: "Invalid locationId" }, { status: 400 });
  }
  if (!sessionId || !/^\d+$/.test(sessionId)) {
    return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `${PANDORA_URL}/bmi/session/${locationId}/${sessionId}/participants`,
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Accept: "application/json",
        },
        cache: "no-store",
      },
    );
    if (!res.ok) {
      console.error(`[session-participants] Pandora ${res.status}: ${await res.text()}`);
      return NextResponse.json(
        { data: [], error: `Pandora ${res.status}` },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }
    const json = await res.json();
    const data: Participant[] = Array.isArray(json.data) ? json.data : [];
    return NextResponse.json(
      { data },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[session-participants] fetch error:", err);
    return NextResponse.json(
      { data: [], error: "fetch failed" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
