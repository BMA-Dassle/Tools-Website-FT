import { NextRequest, NextResponse } from "next/server";
import { closeJoinSessionSchema } from "~/features/kiosk/join/schemas";
import { closeJoinSession } from "~/features/kiosk/join/service";
import { rateLimited } from "~/features/kiosk/join/store";
import { clientIp } from "~/features/account/contact";

/**
 * POST /api/kiosk/join/{code}/close — kiosk closes the session (Continue,
 * start over, idle reset, or normal step exit). Idempotent: already-closed
 * and gone sessions both return 200, and the FIRST close reason wins. Phones
 * read the reason during a short grace window and show "cancelled" vs
 * "expired" accordingly.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CODE_RE = /^[A-Za-z0-9_-]{8,24}$/;

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!CODE_RE.test(code)) return NextResponse.json({ ok: true });
  if (await rateLimited("close", clientIp(req), 60)) {
    return NextResponse.json({ error: "rate-limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = closeJoinSessionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    await closeJoinSession(code, parsed.data.reason);
  } catch (err) {
    // The kiosk fires this close-and-forget (keepalive) — never fail it; an
    // unclosed session dies by TTL within 5 minutes anyway.
    console.error("[kiosk-join] close failed", err);
  }
  return NextResponse.json({ ok: true });
}
