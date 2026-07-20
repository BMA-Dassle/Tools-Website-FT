import { NextRequest, NextResponse } from "next/server";
import { kioskPoll } from "~/features/kiosk/join/service";
import { rateLimited } from "~/features/kiosk/join/store";
import { clientIp } from "~/features/account/contact";

/**
 * GET /api/kiosk/join/{code} — the kiosk's ~3s poll. Doubles as the session
 * keepalive: this is the ONLY call that slides the session TTL, so a crashed
 * kiosk's session dies within 5 minutes no matter how many phones keep
 * polling. Returns joined guests plus phone presence counts.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CODE_RE = /^[A-Za-z0-9_-]{8,24}$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!CODE_RE.test(code)) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }
  // Lax backstop — every kiosk at a venue shares one NAT egress IP.
  if (await rateLimited("poll", clientIp(req), 2000)) {
    return NextResponse.json({ error: "rate-limited" }, { status: 429 });
  }

  try {
    const result = await kioskPoll(code);
    if (result.status === "gone") {
      return NextResponse.json({ error: "not-found" }, { status: 404 });
    }
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store, no-cache, must-revalidate" },
    });
  } catch (err) {
    console.error("[kiosk-join] poll failed", err);
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
