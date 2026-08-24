import { NextRequest, NextResponse } from "next/server";

/**
 * BROWSER PROXY for the SMS-Timing best-times (Hall of Fame) API.
 *
 * The kiosk Race Info hub and /leaderboards are client components and cannot
 * hold the upstream's access token, so they come through here. The token
 * renewal and the upstream call itself live in ~/features/racing/best-times
 * .server, shared with the signage top-times wall — this file is now only the
 * HTTP shell around it (2026-08-17).
 */
import { fetchBestTimes } from "~/features/racing/best-times.server";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  try {
    const data = await fetchBestTimes({
      endpoint: searchParams.get("endpoint") || "records",
      rscId: searchParams.get("rscId") || "-1",
      scgId: searchParams.get("scgId") || "",
      startDate: searchParams.get("startDate") || "",
      maxResult: searchParams.get("maxResult") || "10",
    });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Besttimes API error" },
      { status: 500 },
    );
  }
}
