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
 * Server-side 30s in-memory cache keyed by sessionId so the check-in cron can
 * hit the same session a few times within a minute without thrashing Pandora.
 */

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";
const CACHE_TTL_MS = 30_000;

const ALLOWED_LOCATIONS = new Set([
  "LAB52GY480CJF", // FastTrax
  "TXBSQN0FEKQ11", // HeadPinz Fort Myers
  "PPTR5G2N0QXF7", // HeadPinz Naples
]);

// The upstream shape — re-export our shared canonical type for consumers.
export type { Participant } from "@/lib/participant-contact";
import type { Participant } from "@/lib/participant-contact";

const cache: Map<string, { data: Participant[]; expiry: number }> = new Map();

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

  const key = `${locationId}:${sessionId}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiry) {
    return NextResponse.json(
      { data: hit.data },
      { headers: { "X-Cache": "HIT", "Cache-Control": "no-store" } },
    );
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
    cache.set(key, { data, expiry: Date.now() + CACHE_TTL_MS });
    return NextResponse.json(
      { data },
      { headers: { "X-Cache": "MISS", "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[session-participants] fetch error:", err);
    const stale = cache.get(key)?.data ?? [];
    return NextResponse.json(
      { data: stale, error: "fetch failed" },
      { headers: { "X-Cache": "ERROR", "Cache-Control": "no-store" } },
    );
  }
}
