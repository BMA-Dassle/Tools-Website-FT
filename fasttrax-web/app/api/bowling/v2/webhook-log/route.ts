import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

/**
 * GET /api/bowling/v2/webhook-log
 *
 * Returns the last N entries from the QAMF webhook debug log.
 * Query params:
 *   ?limit=50       — how many entries (default 50, max 500)
 *   ?qamfId=X148054 — filter to a specific reservation ID
 *   ?type=reservation.updated — filter by event type
 *
 * Protected by the same admin token used by the reservations page.
 * Temporary endpoint for debugging webhook payloads.
 */

const DEBUG_LOG_KEY = "qamf:bowling:debug-log";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);

  // Simple auth — same admin token as middleware gate
  const token = url.searchParams.get("token") || "";
  if (!token || token !== process.env.ADMIN_CAMERA_TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 500);
  const filterQamfId = url.searchParams.get("qamfId") || "";
  const filterType = url.searchParams.get("type") || "";

  const raw = await redis.lrange(DEBUG_LOG_KEY, 0, limit * 3); // fetch extra to allow for filtering

  let entries = raw
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  // Apply filters
  if (filterQamfId) {
    entries = entries.filter(
      (e: { raw?: { Data?: { Id?: string } } }) => e.raw?.Data?.Id === filterQamfId,
    );
  }
  if (filterType) {
    entries = entries.filter((e: { eventType?: string }) => e.eventType === filterType);
  }

  return NextResponse.json({
    ok: true,
    count: entries.length,
    entries: entries.slice(0, limit),
  });
}
