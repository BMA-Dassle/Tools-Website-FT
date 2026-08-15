import { NextResponse } from "next/server";
import { readRaceClocks } from "~/features/racing/race-clock.server";

/**
 * The live race countdown, for every screen in the building.
 *
 * Returns the CLOCK TERMS (start, duration, banked pause, pause-open-since)
 * alongside a server-computed `remainingMs`, so a screen can tick locally at
 * 1 Hz off one fetch instead of polling once a second — that difference is the
 * whole reason this is shaped the way it is, with a TV per room and more coming.
 *
 * `serverNowMs` is the anchor: shop TVs have unreliable system clocks, so the
 * client measures its own offset against this rather than trusting Date.now().
 *
 * Not cached. The payload is small and the terms change on staff actions
 * (a pause, a time-add) that must reach the wall immediately — a cache here
 * would show a frozen countdown, which is worse than no countdown.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = await readRaceClocks();
    return NextResponse.json(snapshot, {
      headers: { "cache-control": "no-store, max-age=0" },
    });
  } catch (err) {
    console.error("[race-clock] read failed:", err);
    // A screen must degrade to "no clock", never to a crashed scene.
    return NextResponse.json(
      { serverNowMs: Date.now(), clocks: [] },
      { status: 200, headers: { "cache-control": "no-store, max-age=0" } },
    );
  }
}
