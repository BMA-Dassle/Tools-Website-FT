import { NextRequest, NextResponse } from "next/server";
import { assistAlertSchema, sendAssistAlert } from "~/features/kiosk/assist-alert";

/**
 * POST /api/kiosk/assist — a kiosk's "Guest assistance" beacon is active.
 * Relays a spoken alert to the venue's FOH staff radios. The kiosk client
 * re-POSTs every 30s while the beacon is up, so one call = one radio play
 * (twice: message + "please advise"), and the repeat is the escalation.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = assistAlertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const delivered = await sendAssistAlert(parsed.data);
  // 200 either way — the kiosk beacon must not care; `delivered` is for logs.
  return NextResponse.json({ ok: true, delivered });
}
