import { NextRequest, NextResponse } from "next/server";
import { listPending, listDead, pendingCount } from "@/lib/sms-retry";

/**
 * SMS retry queue viewer.
 *
 *   GET /api/sms-retry-queue           — summary + pending entries (default)
 *   GET /api/sms-retry-queue?dead=1    — dead-letter list (exhausted retries)
 *   GET /api/sms-retry-queue?limit=500
 *
 * Same auth pattern as /api/sms-log.
 */

const API_KEY = process.env.BOOKING_API_KEY || "CMXDJ9fct3--Js6u_c_mXUKGcv1GbbBBspVSuipdiT4";

function requireAuth(req: NextRequest): NextResponse | null {
  const referer = req.headers.get("referer") || "";
  const origin = req.headers.get("origin") || "";
  const host = req.headers.get("host") || "";
  if (referer.includes(host) || origin.includes(host)) return null;
  const key = req.headers.get("x-api-key") || new URL(req.url).searchParams.get("apiKey");
  if (!key || key !== API_KEY) {
    return NextResponse.json({ error: "Unauthorized — provide x-api-key" }, { status: 401 });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const authErr = requireAuth(req);
  if (authErr) return authErr;

  const { searchParams } = new URL(req.url);
  const wantDead = searchParams.get("dead") === "1";
  const limit = Math.max(1, Math.min(1000, parseInt(searchParams.get("limit") || "200", 10) || 200));

  const pending = await pendingCount();
  const entries = wantDead ? await listDead(limit) : await listPending(limit);

  return NextResponse.json(
    {
      pendingCount: pending,
      listing: wantDead ? "dead" : "pending",
      returned: entries.length,
      entries,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
