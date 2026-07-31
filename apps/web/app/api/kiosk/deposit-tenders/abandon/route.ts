import { NextRequest, NextResponse } from "next/server";
import { abandonSplit } from "~/features/kiosk/service/split-tenders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Release every un-captured split-tender auth NOW — fired by the kiosk's
 * idle-reset / "cancel everything" paths (sendBeacon-friendly: tiny body, no
 * response needed). Square's ~36h auto-void is the backstop, not the
 * mechanism: a guest's gift card must not show a hold for a day and a half
 * because a session timed out.
 */
export async function POST(req: NextRequest) {
  let body: { seed?: string; splitToken?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!body.seed || !body.splitToken) {
    return NextResponse.json({ error: "seed and splitToken required" }, { status: 400 });
  }
  const result = await abandonSplit({ seed: body.seed, splitToken: body.splitToken });
  if (!result.ok) {
    return NextResponse.json({ error: "Already captured" }, { status: 409 });
  }
  console.log(`[kiosk-split] abandoned seed=${body.seed} (auths released)`);
  return NextResponse.json({ ok: true });
}
