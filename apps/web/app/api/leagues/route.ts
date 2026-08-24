import { NextRequest, NextResponse } from "next/server";
import https from "https";
import {
  FRESH_WINDOW_MS,
  isLeaguePullFrozen,
  leagueCacheHeaders,
  leagueReadThrough,
} from "~/features/leagues/pandora-cache";

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
      { hostname: PANDORA_URL, path, headers: { Authorization: `Bearer ${API_KEY}` } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
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
 *
 * ── Caching (2026-08-18) ────────────────────────────────────────────────────
 * Every read goes through the Redis read-through in
 * ~/features/leagues/pandora-cache: standings/summary answer from a copy up to
 * an HOUR old (owner: "leagues needs a cache for sure, could be hour for now"),
 * sessions/scores from one up to 60s old — short on purpose, because
 * /api/cron/level-up-watch only looks at sessions that finished in the last ten
 * minutes and an hour-old list would switch level-up detection off.
 *
 * A failed live call serves the retained copy (kept 30 days) instead of the 500
 * this route used to return — 123 of them in the hour Pandora degraded on
 * 2026-08-18. `X-Cache: FRESH | CACHE | STALE-<reason> | FROZEN` says which copy
 * you got, and `?fresh=1` skips the fresh window for a manual pull.
 *
 * ── The standings FREEZE (owner 2026-08-18: "league is done, disable all that")
 * `standings` and `summary` — the only two reads the public /leagues page makes —
 * additionally honour an ops kill switch (a Redis key, flipped by
 * scripts/leagues-pull.mts). While it is set they NEVER call Pandora: the page
 * serves the copy we kept, at any age, because a finished season's standings
 * cannot change. `?fresh=1` does not punch through it.
 *
 * `sessions` and `scores` are deliberately NOT frozen, and are not league reads
 * despite living on this route: `/api/cron/level-up-watch` polls them every two
 * minutes for the Blue/Red Starter/Intermediate/Pro score groups to spot a racer
 * whose best lap just qualified them for the next TIER. That is everyday racing,
 * it runs whether or not a league season is on, and freezing it would silently
 * switch level-up notifications off. (`scores` is also the /leagues page's
 * per-heat drill-down, which is why a frozen page can still open a heat.)
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");
  const locationId = searchParams.get("location") || "LAB52GY480CJF";
  const forceFresh = searchParams.get("fresh") === "1";

  /** One read: cache-or-live, stale on failure, headers that say which.
   *  `freezable` marks the two league-standings reads the ops kill switch owns. */
  async function serve(
    path: string,
    freshForMs: number,
    failureMessage: string,
    freezable = false,
  ) {
    const pullEnabled = freezable ? !(await isLeaguePullFrozen()) : true;
    const result = await leagueReadThrough({
      path,
      freshForMs,
      forceFresh,
      pullEnabled,
      fetcher: pandoraGet,
    });
    const headers = leagueCacheHeaders(result);
    if (result.json === null) {
      return NextResponse.json(
        { error: failureMessage, details: result.body.substring(0, 200) },
        { status: result.status, headers },
      );
    }
    return NextResponse.json(result.json, { status: result.status, headers });
  }

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
      if (!scoreGroupsRaw)
        return NextResponse.json({ error: "scoreGroups required" }, { status: 400 });

      // The user-supplied list is already comma-separated league names.
      // Pandora wants them URI-encoded as a single value (commas
      // preserved as %2C). encodeURIComponent on the whole string does
      // that correctly.
      const encodedGroups = encodeURIComponent(scoreGroupsRaw);
      const encodedStart = encodeURIComponent(startDate);
      const encodedEnd = encodeURIComponent(endDate);

      const path = `/v2/bmi/records/standings/${locationId}?startDate=${encodedStart}&endDate=${encodedEnd}&excludePractice=${excludePractice}&scoreGroupName=${encodedGroups}`;
      return await serve(path, FRESH_WINDOW_MS.standings, "Failed to fetch standings", true);
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
      return await serve(path, FRESH_WINDOW_MS.standings, "Failed to fetch standings", true);
    }

    if (action === "sessions") {
      const track = searchParams.get("track") || "Blue Track";
      const scoreGroup = searchParams.get("scoreGroup") || "";
      const startDate = searchParams.get("startDate") || "2026-01-01T00:00:00";
      const endDate = searchParams.get("endDate") || "2026-12-31T23:59:59";

      if (!scoreGroup) return NextResponse.json({ error: "scoreGroup required" }, { status: 400 });

      const path = `/v2/bmi/records/sessions/${locationId}/${encodeURIComponent(track)}/${encodeScoreGroup(scoreGroup)}?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
      return await serve(path, FRESH_WINDOW_MS.live, "Failed to fetch sessions");
    }

    if (action === "scores") {
      const sessionId = searchParams.get("sessionId");
      const scoreGroup = searchParams.get("scoreGroup");
      if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });

      let path = `/v2/bmi/records/scores/${locationId}/${sessionId}`;
      if (scoreGroup) path += `?scoreGroupName=${encodeScoreGroup(scoreGroup)}`;
      return await serve(path, FRESH_WINDOW_MS.live, "Failed to fetch scores");
    }

    return NextResponse.json(
      { error: "action must be summary, sessions, or scores" },
      { status: 400 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "League API error" },
      { status: 500 },
    );
  }
}
