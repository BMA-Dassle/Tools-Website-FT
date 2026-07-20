import { NextRequest, NextResponse } from "next/server";
import { createJoinSessionSchema } from "~/features/kiosk/join/schemas";
import { createJoinSession } from "~/features/kiosk/join/service";
import { rateLimited } from "~/features/kiosk/join/store";
import { clientIp } from "~/features/account/contact";

/**
 * POST /api/kiosk/join — kiosk opens a mobile-join session when its
 * add-players step mounts. Returns the QR payload (joinUrl). One open session
 * per kiosk: creating a new one supersedes the previous code.
 *
 * No device auth (matches the kiosk API surface); the join code itself is the
 * capability. 503 when Redis is down — the kiosk hides the QR panel and
 * manual player entry continues unaffected.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (await rateLimited("create", clientIp(req), 60)) {
    return NextResponse.json({ error: "rate-limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = createJoinSessionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await createJoinSession(parsed.data, req.nextUrl.origin);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[kiosk-join] create failed", err);
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
