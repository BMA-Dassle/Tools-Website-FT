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

// "Mega Track" is the canonical Pandora resource name for Tuesdays (the
// shorter "Mega" was a stale alias that returns 404 from /bmi/sessions).
// Keep "Mega" allowlisted for any old callers but Pandora only matches
// "Mega Track".
const ALLOWED_RESOURCES = new Set(["Blue Track", "Red Track", "Mega", "Mega Track"]);

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

  /**
   * Pandora's /bmi/sessions endpoint goes flaky during peak race
   * windows — sporadic 500s with no clear pattern. The camera-assign
   * page fans out one call per track on each refresh, so a single
   * upstream 500 currently zeroes out the heat list ("0 HEATS · 0
   * DONE · 0 LIVE · 0 UPCOMING") even when only one of three tracks
   * is affected.
   *
   * Mitigations layered here:
   *  1. Retry once on 5xx (or fetch throw) after a 250ms back-off —
   *     usually clears it.
   *  2. On final failure, fall back to whatever was last in our
   *     in-memory cache (any age) before returning empty. Better to
   *     show slightly stale heats than no heats.
   *  3. Surface the upstream body slice in the JSON response so the
   *     page can `console.warn` it for debugging — separate from the
   *     empty fallback so the data path stays uniform.
   */
  async function fetchOnce(): Promise<{ ok: true; data: PandoraSession[] } | { ok: false; status: number | null; body: string }> {
    try {
      const res = await fetch(`${PANDORA_URL}/bmi/sessions/${locationId}?${upstreamQs}`, {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Accept: "application/json",
        },
        cache: "no-store",
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        return { ok: false, status: res.status, body };
      }
      const json = await res.json();
      const data: PandoraSession[] = Array.isArray(json?.data) ? json.data : [];
      return { ok: true, data };
    } catch (err) {
      return { ok: false, status: null, body: err instanceof Error ? err.message : "fetch threw" };
    }
  }

  let attempt = await fetchOnce();
  // Retry once on 5xx / network failure. Don't retry 4xx — those are
  // our fault (auth, bad params) and won't get better.
  if (!attempt.ok && (attempt.status == null || attempt.status >= 500)) {
    await new Promise((r) => setTimeout(r, 250));
    attempt = await fetchOnce();
  }

  if (attempt.ok) {
    cache.set(cacheKey, { data: attempt.data, expiry: Date.now() + CACHE_TTL_MS });
    return NextResponse.json(
      { data: attempt.data },
      { headers: { "X-Cache": "MISS", "Cache-Control": "no-store" } },
    );
  }

  console.error(`[sessions] Pandora ${attempt.status ?? "ERR"} for ${resourceName}: ${attempt.body}`);
  // Fall back to last-known cached data (any age) so the page doesn't
  // zero out during transient Pandora flakiness. Empty array if we've
  // never successfully fetched this combination before.
  const stale = cache.get(cacheKey)?.data ?? [];
  return NextResponse.json(
    {
      data: stale,
      error: `Pandora ${attempt.status ?? "fetch failed"}`,
      upstreamBody: attempt.body.slice(0, 200),
      stale: stale.length > 0,
    },
    { status: 200, headers: { "X-Cache": stale.length > 0 ? "STALE" : "ERROR", "Cache-Control": "no-store" } },
  );
}
