import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/admin/bowling/reservations/resend
 *
 * Admin-only endpoint to resend a bowling confirmation email and/or SMS.
 * Delegates to /api/notifications/bowling-confirmation with forceResend=true
 * to bypass dedup.
 *
 * Body: {
 *   neonId: number;
 *   channel: "email" | "sms" | "both";
 *   overridePhone?: string;   // send to a different phone
 *   overrideEmail?: string;   // send to a different email
 * }
 *
 * Auth: ADMIN_CAMERA_TOKEN query param.
 */
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { neonId, channel, overridePhone, overrideEmail } = body as {
    neonId: number;
    channel: "email" | "sms" | "both";
    overridePhone?: string;
    overrideEmail?: string;
  };

  if (!neonId || !channel) {
    return NextResponse.json({ error: "neonId and channel required" }, { status: 400 });
  }

  // Delegate to the notification route with forceResend + explicit channel
  const origin = req.nextUrl.origin;
  const res = await fetch(`${origin}/api/notifications/bowling-confirmation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      neonId,
      smsOptIn: true, // admin explicitly chose to send
      channel,
      forceResend: true,
      overridePhone,
      overrideEmail,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    return NextResponse.json(data, { status: res.status });
  }

  return NextResponse.json(data);
}
