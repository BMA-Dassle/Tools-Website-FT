import { NextResponse } from "next/server";

/**
 * Shared wall-clock for every kiosk (owner 2026-07-19: "I want the ads and the
 * glow effects timed so all kiosks do the same").
 *
 * Each device measures its offset from THIS clock once (RTT-corrected) and then
 * derives the ad-rotation index (`floor(now / slideMs) % n`) and the CSS glow
 * phase (`animation-delay: -(now % periodMs)`) from the corrected clock — so all
 * kiosks show the same slide and the same breathing glow at the same instant
 * with no per-frame server chatter. Refreshed every few minutes to correct clock
 * drift. Deliberately trivial + uncached: it must reflect real server time.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { now: Date.now() },
    { headers: { "cache-control": "no-store, no-cache, must-revalidate" } },
  );
}
