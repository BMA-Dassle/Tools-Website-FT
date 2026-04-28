import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

/**
 * Proxy for Pandora's session-participants endpoint.
 *
 *   GET /api/pandora/session-participants?locationId=LAB52GY480CJF&sessionId=41781713
 *       &excludeRemoved=true   (default)  — skip participants with F_PAR_STATE = 5
 *       &excludeUnpaid=true    (default)  — skip participants whose bill is unpaid
 *
 * Upstream: GET /bmi/session/{locationID}/{sessionId}/participants
 *
 * ── PII gating ──────────────────────────────────────────────────────────────
 * The upstream payload includes full PII (firstName, lastName, email,
 * mobilePhone, opt-in flags, kart number, etc.) for every racer in the
 * session. The PUBLIC e-ticket pages (/t/[id], /g/[id]) hit this
 * endpoint from the browser to check "is the holder still on this
 * session?" — they only need a personId-membership check, not PII.
 * Browsers were getting the full payload, exposing every co-racer's
 * contact data via DevTools.
 *
 * The route returns a LEAN response by default — one `{ personId }`
 * per participant, nothing else. Server-side callers that legitimately
 * need the full payload (cron SMS senders, admin camera-assign,
 * guardian backfill) opt in by sending `x-pandora-internal:
 * <SWAGGER_ADMIN_KEY>` — a secret only the server has access to. No
 * browser request can forge it.
 *
 * ── Caching ─────────────────────────────────────────────────────────────────
 * Live calls hit Pandora directly — refresh-button workflows always
 * see the latest. The cache is consulted ONLY on Pandora failure
 * (timeout / non-200 / network error), so a degraded upstream falls
 * back to stale-but-real data instead of empty. Staff workflows
 * (camera-assign) keep working through Pandora outages.
 *
 * Cache key is per (location, session, excludeRemoved). `excludeUnpaid`
 * is NOT in the key — we always pull the unpaid-superset upstream and
 * apply that filter at the proxy on response. So:
 *
 *   - the crons (default excludeUnpaid=true) and
 *   - the camera-assign page (excludeUnpaid=false)
 *
 * share ONE cache entry per session. Crons run every 1-2 min and
 * write-through to that shared key, so during operating hours the
 * camera-assign page reads cron-warmed data when Pandora is degraded.
 *
 * ── Forcing fresh ───────────────────────────────────────────────────────────
 * Every request hits Pandora live as the FIRST attempt. There is no
 * cache-first serving — the cache only fires on upstream failure. So
 * the camera-assign refresh button (and any normal request) always
 * returns the freshest available data. A `?fresh=1` query param is
 * accepted as a no-op today (kept so future caching tweaks have a
 * documented bypass).
 */

const CACHE_TTL_SECONDS = 600; // 10 min — long enough to weather a Pandora outage
function cacheKey(locationId: string, sessionId: string, excludeRemoved: boolean): string {
  return `pandora:participants:${locationId}:${sessionId}:R${excludeRemoved ? 1 : 0}`;
}

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

/** Parse a query-string boolean that defaults to `true`. */
function boolParam(raw: string | null, defaultValue: boolean): boolean {
  if (raw == null) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "false" || v === "0" || v === "no") return false;
  if (v === "true" || v === "1" || v === "yes") return true;
  return defaultValue;
}

/** Apply the unpaid filter at the proxy (not at Pandora) so any
 *  cached superset can serve every caller's filter combo. Pandora's
 *  `paid` boolean is the single source of truth — undefined / true
 *  = paid, only an explicit `false` excludes. */
function applyUnpaidFilter(participants: Participant[], excludeUnpaid: boolean): Participant[] {
  if (!excludeUnpaid) return participants;
  return participants.filter((p) => p.paid !== false);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const locationId = searchParams.get("locationId");
  const sessionId = searchParams.get("sessionId");
  const excludeRemoved = boolParam(searchParams.get("excludeRemoved"), true);
  const excludeUnpaid = boolParam(searchParams.get("excludeUnpaid"), true);

  if (!locationId || !ALLOWED_LOCATIONS.has(locationId)) {
    return NextResponse.json({ error: "Invalid locationId" }, { status: 400 });
  }
  if (!sessionId || !/^\d+$/.test(sessionId)) {
    return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
  }

  // Hard timeout on the upstream Pandora fetch — without this,
  // browser polls hung 30+s and stacked up in the renderer until
  // Edge OOM-killed the tab. Falls through to the Redis fallback
  // path (last successful response) when Pandora is degraded.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6_000);

  try {
    // Always pull the unpaid superset from Pandora — single cache
    // entry per (location, session, excludeRemoved) serves every
    // caller's filter combo. We only let Pandora apply
    // `excludeRemoved` (it's a server-state filter we can't
    // reproduce at the proxy without the F_PAR_STATE field).
    const upstreamQs = new URLSearchParams({
      excludeRemoved: String(excludeRemoved),
      excludeUnpaid: "false",
    }).toString();
    const res = await fetch(
      `${PANDORA_URL}/bmi/session/${locationId}/${sessionId}/participants?${upstreamQs}`,
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Accept: "application/json",
        },
        cache: "no-store",
        signal: controller.signal,
      },
    );
    clearTimeout(timeoutId);
    if (!res.ok) {
      console.error(`[session-participants] Pandora ${res.status}: ${await res.text()}`);
      return await fallbackResponse(req, locationId, sessionId, excludeRemoved, excludeUnpaid, `pandora-${res.status}`);
    }
    const json = await res.json();
    const fullSuperset: Participant[] = Array.isArray(json.data) ? json.data : [];

    // Write-through to Redis on every successful upstream fetch
    // (the unpaid superset, NOT the per-caller filtered slice).
    // Fire-and-forget — never block the response on a Redis hiccup.
    if (fullSuperset.length > 0) {
      const key = cacheKey(locationId, sessionId, excludeRemoved);
      redis
        .set(key, JSON.stringify(fullSuperset), "EX", CACHE_TTL_SECONDS)
        .catch((err) => console.warn("[session-participants] cache write failed:", err));
    }

    // Apply the unpaid filter at the proxy + redact PII for
    // untrusted callers (browser).
    const filtered = applyUnpaidFilter(fullSuperset, excludeUnpaid);
    const data = redactIfUntrusted(req, filtered);

    return NextResponse.json(
      { data },
      { headers: { "Cache-Control": "no-store", "X-Cache": "FRESH" } },
    );
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    console.error(
      `[session-participants] ${isTimeout ? "TIMEOUT (>6s)" : "fetch error"}:`,
      err,
    );
    return await fallbackResponse(req, locationId, sessionId, excludeRemoved, excludeUnpaid, isTimeout ? "timeout" : "fetch-failed");
  }
}

/** Strip PII unless the caller proved server-side trust via the
 *  internal-secret header. Lean shape is just `{ personId }`. */
function redactIfUntrusted(req: NextRequest, full: Participant[]): Participant[] | { personId: string | number }[] {
  const internalHeader = req.headers.get("x-pandora-internal");
  const trusted = !!API_KEY && internalHeader === API_KEY;
  return trusted ? full : full.map((p) => ({ personId: p.personId }));
}

/** Pandora unreachable / errored — try the Redis cache before
 *  giving up. The cache holds the unpaid SUPERSET; we apply the
 *  caller's `excludeUnpaid` filter on read so any combo is served
 *  by the same cache entry. Empty cache miss falls through to an
 *  empty array (matches the forgiving-on-error contract the e-ticket
 *  client relies on). */
async function fallbackResponse(
  req: NextRequest,
  locationId: string,
  sessionId: string,
  excludeRemoved: boolean,
  excludeUnpaid: boolean,
  reason: string,
): Promise<NextResponse> {
  try {
    const key = cacheKey(locationId, sessionId, excludeRemoved);
    const raw = await redis.get(key);
    if (raw) {
      const cached = JSON.parse(raw) as Participant[];
      if (Array.isArray(cached) && cached.length > 0) {
        const filtered = applyUnpaidFilter(cached, excludeUnpaid);
        const data = redactIfUntrusted(req, filtered);
        return NextResponse.json(
          { data, stale: true, reason },
          { headers: { "Cache-Control": "no-store", "X-Cache": `STALE-${reason.toUpperCase()}` } },
        );
      }
    }
  } catch (err) {
    console.warn("[session-participants] cache read failed:", err);
  }
  return NextResponse.json(
    { data: [], error: reason },
    { headers: { "Cache-Control": "no-store", "X-Cache": `MISS-${reason.toUpperCase()}` } },
  );
}
