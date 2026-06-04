import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

/**
 * GET /api/admin/bmi-sweep-log
 *
 * Returns the persistent Redis audit log for BMI reservation issues.
 * Two logs:
 *   - bmi:sweep:log  — cron recoveries (cancelled/stuck → Confirmation)
 *   - bmi:confirm:log — every payment/confirm call through the BMI proxy
 *
 * Query params:
 *   type   "sweep" | "confirm" | "all" (default "all")
 *   limit  max entries per log (default 100, max 500)
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") || "all";
  const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10) || 100, 500);

  const result: Record<string, unknown> = {};

  if (type === "sweep" || type === "all") {
    const raw = await redis.lrange("bmi:sweep:log", 0, limit - 1);
    result.sweepRecoveries = raw.map((r) => {
      try {
        return JSON.parse(r);
      } catch {
        return r;
      }
    });
    result.sweepCount = raw.length;
  }

  if (type === "confirm" || type === "all") {
    const raw = await redis.lrange("bmi:confirm:log", 0, limit - 1);
    result.confirmCalls = raw.map((r) => {
      try {
        return JSON.parse(r);
      } catch {
        return r;
      }
    });
    result.confirmCount = raw.length;
  }

  return NextResponse.json(result);
}
