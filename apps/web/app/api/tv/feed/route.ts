import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { buildTvFeed, buildTvPulse } from "~/features/signage/service/feed";
import { signageEnabled } from "~/features/signage/flags";

/**
 * The one endpoint a lobby TV polls.
 *
 * PUBLIC, no token — the same posture as /api/kiosk/device, and for the same
 * reason: this is device layout, not secrets. What it can return is deliberately
 * bounded so that stays true — first names only, never a last name, never an id
 * of any kind, and guest sections only for a screen someone deliberately
 * registered. An unknown screen id gets house ads and nothing else.
 *
 * Never caches: the payload is per-screen and carries a live event rail. The
 * expensive parts are cached server-side inside the feed service instead.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!signageEnabled()) {
    return NextResponse.json({ error: "signage disabled" }, { status: 404 });
  }

  const screen = req.nextUrl.searchParams.get("screen");

  // Fast lane: the live half only. Screens poll this every couple of seconds so
  // a scan reaches the wall while the racer is still at the desk; the full
  // feed, which touches Neon and BMI, stays on a slower cadence.
  if (req.nextUrl.searchParams.get("pulse")) {
    try {
      const pulse = await buildTvPulse(screen);
      return NextResponse.json(pulse, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return NextResponse.json(
        { now: Date.now(), kioskEvents: [], reloadAt: null, demoMode: null },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  try {
    const feed = await buildTvFeed(screen);
    return NextResponse.json(feed, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // A TV must never see an error status — it would have to decide what to
    // render for one. Hand back a well-formed degraded feed and let the screen
    // fall through to house ads, which need no data at all.
    return NextResponse.json(
      {
        now: Date.now(),
        screen: null,
        events: null,
        vip: null,
        kioskEvents: [],
        pausedProductIds: [],
        reloadAt: null,
        demoMode: null,
        degraded: true,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
