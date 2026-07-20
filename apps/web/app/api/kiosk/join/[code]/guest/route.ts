import { NextRequest, NextResponse } from "next/server";
import { submitGuestSchema } from "~/features/kiosk/join/schemas";
import { submitGuest } from "~/features/kiosk/join/service";
import { rateLimited } from "~/features/kiosk/join/store";
import { clientIp } from "~/features/account/contact";

/**
 * POST /api/kiosk/join/{code}/guest — a phone submits one completed guest
 * (public, token = capability). The payload was produced by our own client
 * flows (OTP lookup or Pandora onboarding + waiver) — person ids arrive as
 * digit STRINGS and are validated as such; the server re-checks only the 18+
 * rule. Duplicate submits and replays return success with `alreadyJoined`.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CODE_RE = /^[A-Za-z0-9_-]{8,24}$/;

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!CODE_RE.test(code)) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }
  if (await rateLimited("guest", clientIp(req), 60)) {
    return NextResponse.json({ error: "rate-limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = submitGuestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await submitGuest(code, parsed.data.clientId, parsed.data.guest);
    if (result.ok) return NextResponse.json(result);
    switch (result.error) {
      case "gone":
        return NextResponse.json({ error: "not-found" }, { status: 404 });
      case "must-be-adult":
        return NextResponse.json({ error: "must-be-adult" }, { status: 422 });
      case "closed":
        return NextResponse.json({ error: "closed", reason: result.reason }, { status: 409 });
      case "landed-late":
        return NextResponse.json({ error: "landed-late" }, { status: 409 });
      case "full":
        return NextResponse.json({ error: "full" }, { status: 409 });
    }
  } catch (err) {
    console.error("[kiosk-join] guest submit failed", err);
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
