import { NextResponse } from "next/server";

/**
 * Proxy for Pandora's "currently called races per track" endpoint.
 *
 * GET /api/pandora/races-current
 *
 * Returns { blue, red, mega } — each is a CurrentRace object or null.
 * Pandora auto-expires entries 20 minutes after the last heat is called.
 *
 * Server-side 12-second in-memory cache so all browser clients share one
 * Pandora fetch instead of each polling independently.
 */

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
const CACHE_TTL_MS = 12_000; // 12 seconds

// ── Module-scope cache ───────────────────────────────────────────────────────
let cached: { data: unknown; expiry: number } | null = null;

export async function GET() {
  // Return cached if fresh
  if (cached && Date.now() < cached.expiry) {
    return NextResponse.json(cached.data, {
      headers: { "X-Cache": "HIT", "Cache-Control": "no-store" },
    });
  }

  try {
    const res = await fetch(
      `${PANDORA_URL}/bmi/races/current/${FASTTRAX_LOCATION_ID}`,
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Accept: "application/json",
        },
        cache: "no-store",
      },
    );

    if (!res.ok) {
      console.error(`[races-current] Pandora ${res.status}: ${await res.text()}`);
      return NextResponse.json(
        { blue: null, red: null, mega: null },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }

    const json = await res.json();
    const data = json.data ?? { blue: null, red: null, mega: null };

    // Store in cache
    cached = { data, expiry: Date.now() + CACHE_TTL_MS };

    return NextResponse.json(data, {
      headers: { "X-Cache": "MISS", "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[races-current] fetch error:", err);
    // Return stale cache if available, otherwise empty
    const fallback = cached?.data ?? { blue: null, red: null, mega: null };
    return NextResponse.json(fallback, {
      headers: { "X-Cache": "ERROR", "Cache-Control": "no-store" },
    });
  }
}
