import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { normaliseKart, readDriverView } from "~/features/racing/driver-view/service.server";

/**
 * The driver view's poll — flags, incidents, laps and who is in the kart.
 *
 * PUBLIC AND UNAUTHENTICATED, on purpose. The kart number is the whole key
 * (owner 2026-09-05: no pass, no scan, no sign-in), so anything a caller could
 * learn here is already visible on the nose cone in front of them and on the
 * leaderboard on the wall: a first name, a lap time, a flag. No contact details,
 * no booking, no person id leaves this route — `binding.personId` is
 * deliberately stripped below. It is the join key for our own tables, not
 * something a guest needs or should be handed.
 *
 * NOT THE LIVE POSITION. The clock, the running order and the gap come from the
 * SMS-Timing cloud socket, which the browser opens directly. Nothing here may
 * open that socket — a server-side connection displaces the live subscribers
 * and takes the boards down mid-race.
 *
 * Poll cadence is the client's; this is cheap (two Redis reads and one indexed
 * Neon query) and deliberately uncached, because a red flag two seconds stale is
 * a red flag that failed.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  const kart = normaliseKart(number);
  if (!kart) {
    return NextResponse.json({ error: "bad kart number" }, { status: 400 });
  }

  try {
    const state = await readDriverView(kart);
    const { binding, ...rest } = state;
    return NextResponse.json(
      {
        ...rest,
        // Everything about the driver except the id that joins our tables.
        binding: binding
          ? {
              kart: binding.kart,
              participantName: binding.participantName,
              sessionId: binding.sessionId,
              sessionName: binding.sessionName,
              track: binding.track,
              updatedAtMs: binding.updatedAtMs,
            }
          : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[api/kart] failed:", err);
    // A screen that cannot reach us must fall back to the live socket alone,
    // not to an error page — the position and the clock still work without us.
    return NextResponse.json(
      { kart, binding: null, laps: [], alerts: [], takeover: null, degraded: true },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
