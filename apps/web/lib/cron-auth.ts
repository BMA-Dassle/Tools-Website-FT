import { NextRequest, NextResponse } from "next/server";

/**
 * Verify the request is a legitimate Vercel cron trigger.
 *
 * When CRON_SECRET is set in Vercel, cron requests include
 * `Authorization: Bearer <secret>`. Returns a 401 response
 * if the header doesn't match, or null if the request is valid.
 *
 * Also blocks non-production environments (preview deployments) and the
 * admin Vercel project (which builds this same app — see below).
 */
export function verifyCron(req: NextRequest): NextResponse | null {
  // The admin deployment (second Vercel project, same repo root, behind
  // Vercel Authentication) registers the exact same vercel.json crons as the
  // main project. The main project owns ALL scheduled work — without this
  // guard every sweep would double-fire against the same Neon/BMI/Square.
  // Defense-in-depth behind the dashboard "Disable Cron Jobs" toggle; the
  // 200 "skipped" keeps Vercel from flagging any gap invocations as failures.
  if (process.env.ADMIN_DEPLOYMENT) {
    return NextResponse.json({ ok: true, skipped: "admin deployment" });
  }

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
