import { NextRequest, NextResponse } from "next/server";

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
    const fullData: Participant[] = Array.isArray(json.data) ? json.data : [];

    // ── Trust check ───────────────────────────────────────────────
    // Server-side callers (cron, admin) send the internal-secret
    // header. Browser requests from the public e-ticket pages can't
    // forge it (the secret only lives in server env). Without the
    // header we strip every PII field and return only the personId
    // so client polling can still answer "am I still on the
    // roster?" without leaking a co-racer's name/email/phone.
    const internalHeader = req.headers.get("x-pandora-internal");
    const trusted = !!API_KEY && internalHeader === API_KEY;

    const data = trusted
      ? fullData
      : fullData.map((p) => ({ personId: p.personId }));

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
