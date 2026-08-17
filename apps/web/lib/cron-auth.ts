import { NextRequest, NextResponse } from "next/server";

/**
 * Verify the request is a legitimate Vercel cron trigger.
 *
 * When CRON_SECRET is set in Vercel, cron requests include
 * `Authorization: Bearer <secret>`. Returns a 401 response
 * if the header doesn't match, or null if the request is valid.
 *
 * Also blocks non-production environments (preview deployments).
 *
 * NOTE: when CRON_SECRET is unset this FAILS OPEN (no auth at all) — pinned
 * by cron-auth.test.ts. Any future second Vercel project sharing this app's
 * root directory would register vercel.json's crons too and run them against
 * the same Neon/BMI/Square; omitting CRON_SECRET there would NOT stop them.
 * (The staff admin project avoids this entirely — apps/admin has its own
 * root and no vercel.json.)
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
