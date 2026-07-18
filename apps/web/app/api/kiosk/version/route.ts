import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The deploy this server is running, for the kiosk's self-update check. A kiosk
 * tab records this at boot; on each reset (Start Over / post-booking) it re-reads
 * this — a changed value means a newer deploy is live, so the reset hard-reloads
 * to pick it up instead of a soft nav (staff no longer close+reopen the browser).
 * Vercel populates VERCEL_GIT_COMMIT_SHA per deployment.
 */
export function GET() {
  const version = process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || "dev";
  return NextResponse.json(
    { version },
    { headers: { "cache-control": "no-store, no-cache, must-revalidate, max-age=0" } },
  );
}
