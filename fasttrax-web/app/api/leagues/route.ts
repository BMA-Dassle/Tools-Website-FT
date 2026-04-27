import { NextRequest, NextResponse } from "next/server";
import https from "https";

const PANDORA_URL = "bma-pandora-api.azurewebsites.net";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";

/** Double-encode slashes in score group names so they survive HTTP path normalization */
function encodeScoreGroup(name: string): string {
  // First encode normally, then re-encode any %2F to %252F
  return encodeURIComponent(name).replace(/%2F/gi, "%252F");
}

function pandoraGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: PANDORA_URL, path, headers: { "Authorization": `Bearer ${API_KEY}` } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

/**
 * League standings API proxy.
 *
 * GET ?action=standings&location=...&scoreGroups=A,B&startDate=...&endDate=...&excludePractice=true
 *     New combined endpoint — one call returns drivers from ALL listed
 *     score groups merged. Used by the public /leagues page.
 *
 * GET ?action=summary&location=LAB52GY480CJF&track=Blue+Track&scoreGroup=...&startDate=...&endDate=...
 *     Legacy per-(track, scoreGroup) endpoint. Kept for any caller that
 *     still relies on it; consider removing after callers migrate.
 *
 * GET ?action=sessions&location=...&track=...&scoreGroup=...&startDate=...&endDate=...
 * GET ?action=scores&location=...&sessionId=12345
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");
  const locationId = searchParams.get("location") || "LAB52GY480CJF";

  try {
    if (action === "standings") {
      // Combined-leagues endpoint:
      //   /v2/bmi/records/standings/{locationId}
      //     ?startDate=...&endDate=...&excludePractice=...
      //     &scoreGroupName={comma-separated, URI-encoded}
      const scoreGroupsRaw = searchParams.get("scoreGroups") || "";
      const startDate = searchParams.get("startDate") || "2026-01-01T00:00:00";
      const endDate = searchParams.get("endDate") || "2026-12-31T23:59:59";
      const excludePractice = searchParams.get("excludePractice") || "false";
      if (!scoreGroupsRaw) return NextResponse.json({ error: "scoreGroups required" }, { status: 400 });

      // The user-supplied list is already comma-separated league names.
      // Pandora wants them URI-encoded as a single value (commas
      // preserved as %2C). encodeURIComponent on the whole string does
      // that correctly.
      const encodedGroups = encodeURIComponent(scoreGroupsRaw);
      const encodedStart = encodeURIComponent(startDate);
      const encodedEnd = encodeURIComponent(endDate);

      const path = `/v2/bmi/records/standings/${locationId}?startDate=${encodedStart}&endDate=${encodedEnd}&excludePractice=${excludePractice}&scoreGroupName=${encodedGroups}`;
      const res = await pandoraGet(path);
      if (res.status >= 400) {
        return NextResponse.json(
          { error: "Failed to fetch standings", details: res.body.substring(0, 200) },
          { status: res.status },
        );
      }
      return NextResponse.json(JSON.parse(res.body));
    }

    if (action === "summary") {
      const track = searchParams.get("track") || "Blue Track";
      const scoreGroup = searchParams.get("scoreGroup") || "";
      const startDate = searchParams.get("startDate") || "2026-01-01T00:00:00";
      const endDate = searchParams.get("endDate") || "2026-12-31T23:59:59";
      const excludePractice = searchParams.get("excludePractice") || "false";

      if (!scoreGroup) return NextResponse.json({ error: "scoreGroup required" }, { status: 400 });

      const encodedTrack = encodeURIComponent(track);
      const encodedGroup = encodeScoreGroup(scoreGroup);
      const encodedStart = encodeURIComponent(startDate);
      const encodedEnd = encodeURIComponent(endDate);

      const path = `/v2/bmi/records/summary/${locationId}/${encodedTrack}/${encodedGroup}?startDate=${encodedStart}&endDate=${encodedEnd}&excludePractice=${excludePractice}`;
      const res = await pandoraGet(path);
      if (res.status >= 400) {
        return NextResponse.json({ error: "Failed to fetch standings", details: res.body.substring(0, 200) }, { status: res.status });
      }
      return NextResponse.json(JSON.parse(res.body));
    }

    if (action === "sessions") {
      const track = searchParams.get("track") || "Blue Track";
      const scoreGroup = searchParams.get("scoreGroup") || "";
      const startDate = searchParams.get("startDate") || "2026-01-01T00:00:00";
      const endDate = searchParams.get("endDate") || "2026-12-31T23:59:59";

      if (!scoreGroup) return NextResponse.json({ error: "scoreGroup required" }, { status: 400 });

      const path = `/v2/bmi/records/sessions/${locationId}/${encodeURIComponent(track)}/${encodeScoreGroup(scoreGroup)}?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
      const res = await pandoraGet(path);
      if (res.status >= 400) {
        return NextResponse.json({ error: "Failed to fetch sessions" }, { status: res.status });
      }
      return NextResponse.json(JSON.parse(res.body));
    }

    if (action === "scores") {
      const sessionId = searchParams.get("sessionId");
      const scoreGroup = searchParams.get("scoreGroup");
      if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });

      let path = `/v2/bmi/records/scores/${locationId}/${sessionId}`;
      if (scoreGroup) path += `?scoreGroupName=${encodeScoreGroup(scoreGroup)}`;
      const res = await pandoraGet(path);
      if (res.status >= 400) {
        return NextResponse.json({ error: "Failed to fetch scores" }, { status: res.status });
      }
      return NextResponse.json(JSON.parse(res.body));
    }

    return NextResponse.json({ error: "action must be summary, sessions, or scores" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "League API error" }, { status: 500 });
  }
}
