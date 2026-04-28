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
 * From this commit, the route returns a LEAN response by default —
 * one `{ personId }` per participant, nothing else. Server-side
 * callers that legitimately need the full payload (cron SMS senders,
 * admin camera-assign, guardian backfill) opt in by sending
 * `x-pandora-internal: <SWAGGER_ADMIN_KEY>` — a secret only the
 * server has access to. No browser request can forge it.
 *
 * Defaults match what the SMS crons need — notifications must never fire for
 * unpaid or removed participants — so every existing caller stays safe.
 * Callers that need the un-filtered view (e.g., the camera-assign page wants
 * to show unpaid racers so staff can still bind a camera) pass
 * `excludeUnpaid=false` explicitly.
 *
 * ── Caching ─────────────────────────────────────────────────────────────────
 * Live calls hit Pandora directly — rosters change in real time and a
 * stale roster causes the pre-race cron to miss fresh participants.
 *
 * BUT: when Pandora is degraded (the proxy hits its 6s timeout), the
 * staff camera-assign page would see an EMPTY roster and lose the
 * ability to bind cameras while Pandora recovers. So every successful
 * response writes-through to Redis with a 10-minute TTL, and the
 * timeout / error branch falls back to that cache. Stale-but-real
 * data is strictly better than empty for staff workflows. The
 * response carries `stale: true` so consumers know.
 */
const CACHE_TTL_SECONDS = 600; // 10 minutes — long enough to weather a Pandora outage, short enough to stay fresh
function cacheKey(locationId: string, sessionId: string, excludeRemoved: boolean, excludeUnpaid: boolean): string {
  // Per-filter-combo key — different excludeRemoved/excludeUnpaid yield different rosters.
  return `pandora:participants:${locationId}:${sessionId}:${excludeRemoved ? 1 : 0}${excludeUnpaid ? 1 : 0}`;
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

/** Parse a query-string boolean that defaults to `true`. Accepts
 *  `false`/`0`/`no` (case-insensitive) as false; anything else is true. */
function boolParam(raw: string | null, defaultValue: boolean): boolean {
  if (raw == null) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "false" || v === "0" || v === "no") return false;
  if (v === "true" || v === "1" || v === "yes") return true;
  return defaultValue;
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

  // Hard timeout on the upstream Pandora fetch — same rationale as
  // the races-current proxy. Pandora has been observed taking 30+s
  // to respond under load. Without a timeout, browser polls stack
  // up and the e-ticket renderer eventually OOMs.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6_000);

  try {
    const upstreamQs = new URLSearchParams({
      excludeRemoved: String(excludeRemoved),
      excludeUnpaid: String(excludeUnpaid),
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
      // Pandora returned a non-200 (often 401/500). Try the
      // Redis fallback before giving up — staff would rather see
      // a 5-minute-old roster than no roster at all.
      return await fallbackResponse(req, locationId, sessionId, excludeRemoved, excludeUnpaid, `pandora-${res.status}`);
    }
    const json = await res.json();
    const fullData: Participant[] = Array.isArray(json.data) ? json.data : [];

    // Write-through to Redis on every successful upstream fetch so
    // the next outage falls back to fresh-ish data. Fire-and-forget
    // — never block the response on a Redis hiccup.
    if (fullData.length > 0) {
      const key = cacheKey(locationId, sessionId, excludeRemoved, excludeUnpaid);
      redis
        .set(key, JSON.stringify(fullData), "EX", CACHE_TTL_SECONDS)
        .catch((err) => console.warn("[session-participants] cache write failed:", err));
    }

    // ── Trust check ───────────────────────────────────────────────
    // Server-side callers (cron, admin) send the internal-secret
    // header. Browser requests from the public e-ticket pages can't
    // forge it (the secret only lives in server env). Without the
    // header we strip every PII field and return only the personId
    // so client polling can still answer "am I still on the
    // roster?" without leaking a co-racer's name/email/phone.
    const data = redactIfUntrusted(req, fullData);

    return NextResponse.json(
      { data },
      { headers: { "Cache-Control": "no-store" } },
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
 *  giving up. If we have a recent roster, return that with
 *  `stale: true` so consumers know it's not real-time. Empty cache
 *  miss → empty array (matches the prior forgiving-on-error contract
 *  the e-ticket client relies on). */
async function fallbackResponse(
  req: NextRequest,
  locationId: string,
  sessionId: string,
  excludeRemoved: boolean,
  excludeUnpaid: boolean,
  reason: string,
): Promise<NextResponse> {
  try {
    const key = cacheKey(locationId, sessionId, excludeRemoved, excludeUnpaid);
    const raw = await redis.get(key);
    if (raw) {
      const cached = JSON.parse(raw) as Participant[];
      if (Array.isArray(cached) && cached.length > 0) {
        const data = redactIfUntrusted(req, cached);
        return NextResponse.json(
          { data, stale: true, reason },
          { headers: { "Cache-Control": "no-store", "X-Cache": `STALE-${reason.toUpperCase()}` } },
        );
      }
    }
  } catch (err) {
    console.warn("[session-participants] cache read failed:", err);
  }
  // Empty list = "don't invalidate the ticket" — the client-side
  // `isStillOnSession` is intentionally forgiving on empty/error
  // reads so a slow Pandora doesn't flip valid tickets to
  // PreRaceCard's "no longer valid" state.
  return NextResponse.json(
    { data: [], error: reason },
    { headers: { "Cache-Control": "no-store", "X-Cache": `MISS-${reason.toUpperCase()}` } },
  );
}
