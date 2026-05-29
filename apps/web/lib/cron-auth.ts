import { NextRequest, NextResponse } from "next/server";

/**
 * Verify the request is a legitimate Vercel cron trigger.
 *
 * When CRON_SECRET is set in Vercel, cron requests include
 * `Authorization: Bearer <secret>`. Returns a 401 response
 * if the header doesn't match, or null if the request is valid.
 *
 * Also blocks non-production environments (preview deployments).
 */
export function verifyCron(req: NextRequest): NextResponse | null {
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") {
    return NextResponse.json({ ok: true, skipped: "not production" });
  }

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return null;
}
