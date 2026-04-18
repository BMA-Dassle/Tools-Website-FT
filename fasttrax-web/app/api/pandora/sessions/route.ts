import { NextRequest, NextResponse } from "next/server";

/**
 * Proxy for Pandora's sessions-list endpoint.
 *
 *   GET /api/pandora/sessions?locationId=LAB52GY480CJF&startDate=...&endDate=...&resourceName=Blue%20Track
 *
 * Upstream: GET /bmi/sessions/{locationID}?startDate&endDate&resourceName
 *
 * Response: { success, data: [{ sessionId, name, scheduledStart, type, heatNumber }] }
 *
 * Server-side 60s in-memory cache per (location, resourceName, window) so
 * the pre-race cron doesn't thrash Pandora when running every few minutes.
 */

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";
const CACHE_TTL_MS = 60_000;

const ALLOWED_LOCATIONS = new Set([
  "LAB52GY480CJF", // FastTrax
  "TXBSQN0FEKQ11", // HeadPinz Fort Myers
  "PPTR5G2N0QXF7", // HeadPinz Naples
]);

const ALLOWED_RESOURCES = new Set(["Blue Track", "Red Track", "Mega"]);

export interface PandoraSession {
  sessionId: string;         // string per Pandora schema
  name: string;              // e.g. "19 - Blue Junior Starter"
  scheduledStart: string;    // ISO 8601 UTC
  type: string;              // "Starter" | "Junior Starter" | "Intermediate" | "Pro" | "Intermediate (2)" etc.
  heatNumber: number;
}

const cache: Map<string, { data: PandoraSession[]; expiry: number }> = new Map();

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const locationId = searchParams.get("locationId");
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  const resourceName = searchParams.get("resourceName");

  if (!locationId || !ALLOWED_LOCATIONS.has(locationId)) {
    return NextResponse.json({ error: "Invalid locationId" }, { status: 400 });
  }
  if (!startDate || !endDate) {
    return NextResponse.json({ error: "startDate and endDate required" }, { status: 400 });
  }
  if (!resourceName || !ALLOWED_RESOURCES.has(resourceName)) {
    return NextResponse.json({ error: "Invalid resourceName (Blue Track / Red Track / Mega)" }, { status: 400 });
  }

  const cacheKey = `${locationId}|${resourceName}|${startDate}|${endDate}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() < hit.expiry) {
    return NextResponse.json(
      { data: hit.data },
      { headers: { "X-Cache": "HIT", "Cache-Control": "no-store" } },
    );
  }

  const upstreamQs = new URLSearchParams({
    startDate,
    endDate,
    resourceName,
  }).toString();

  try {
    const res = await fetch(`${PANDORA_URL}/bmi/sessions/${locationId}?${upstreamQs}`, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      console.error(`[sessions] Pandora ${res.status} for ${resourceName}: ${(await res.text()).slice(0, 300)}`);
      return NextResponse.json(
        { data: [], error: `Pandora ${res.status}` },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }

    const json = await res.json();
    const data: PandoraSession[] = Array.isArray(json?.data) ? json.data : [];
    cache.set(cacheKey, { data, expiry: Date.now() + CACHE_TTL_MS });
    return NextResponse.json(
      { data },
      { headers: { "X-Cache": "MISS", "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[sessions] fetch error:", err);
    const stale = cache.get(cacheKey)?.data ?? [];
    return NextResponse.json(
      { data: stale, error: "fetch failed" },
      { headers: { "X-Cache": "ERROR", "Cache-Control": "no-store" } },
    );
  }
}
