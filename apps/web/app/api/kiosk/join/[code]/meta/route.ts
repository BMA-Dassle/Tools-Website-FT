import { NextRequest, NextResponse } from "next/server";
import { clientStageSchema } from "~/features/kiosk/join/schemas";
import { guestMeta } from "~/features/kiosk/join/service";
import { rateLimited } from "~/features/kiosk/join/store";
import { clientIp } from "~/features/account/contact";

/**
 * GET /api/kiosk/join/{code}/meta — the phone's ~5s status poll (public).
 * With ?clientId= (and optional &stage=) it doubles as the presence
 * heartbeat that drives the kiosk's "phone sign-in in progress" warning —
 * there is no separate hello route. Never slides the session TTL; only the
 * kiosk keeps a session alive.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CODE_RE = /^[A-Za-z0-9_-]{8,24}$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!CODE_RE.test(code)) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }
  // Lax backstop — every phone at the venue shares one NAT egress IP.
  if (await rateLimited("meta", clientIp(req), 2000)) {
    return NextResponse.json({ error: "rate-limited" }, { status: 429 });
  }

  const rawClientId = req.nextUrl.searchParams.get("clientId");
  const clientId =
    rawClientId && rawClientId.length >= 8 && rawClientId.length <= 64 ? rawClientId : undefined;
  const stageParse = clientStageSchema.safeParse(req.nextUrl.searchParams.get("stage"));
  const stage = stageParse.success ? stageParse.data : undefined;

  try {
    const result = await guestMeta(code, clientId, stage);
    if (result.status === "gone") {
      return NextResponse.json({ error: "not-found" }, { status: 404 });
    }
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store, no-cache, must-revalidate" },
    });
  } catch (err) {
    console.error("[kiosk-join] meta failed", err);
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
