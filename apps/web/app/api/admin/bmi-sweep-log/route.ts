import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

/**
 * GET /api/admin/bmi-sweep-log
 *
 * Returns the persistent Redis audit logs for BMI reservation issues.
 *
 * Three logs:
 *   - bmi:api:log    — all BMI public API calls (booking/book, payment/confirm, etc.)
 *   - bmi:sweep:log  — cron recoveries (cancelled/stuck → Confirmation)
 *   - bmi:confirm:log — legacy (payment/confirm only, being replaced by api:log)
 *
 * Query params:
 *   type    "api" | "sweep" | "confirm" | "all" (default "all")
 *   limit   max entries per log (default 100, max 500)
 *   filter  optional — only return entries where any field contains this string
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") || "all";
  const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10) || 100, 500);
  const filter = searchParams.get("filter") || "";

  function parse(raw: string[]) {
    let entries = raw.map((r) => {
      try {
        return JSON.parse(r);
      } catch {
        return { raw: r };
      }
    });
    if (filter) {
      entries = entries.filter((e) =>
        JSON.stringify(e).toLowerCase().includes(filter.toLowerCase()),
      );
    }
    return entries;
  }

  const result: Record<string, unknown> = {};

  if (type === "api" || type === "all") {
    const raw = await redis.lrange("bmi:api:log", 0, limit - 1);
    result.apiCalls = parse(raw);
    result.apiCount =
      result.apiCalls && Array.isArray(result.apiCalls) ? result.apiCalls.length : 0;
  }

  if (type === "sweep" || type === "all") {
    const raw = await redis.lrange("bmi:sweep:log", 0, limit - 1);
    result.sweepRecoveries = parse(raw);
    result.sweepCount =
      result.sweepRecoveries && Array.isArray(result.sweepRecoveries)
        ? result.sweepRecoveries.length
        : 0;
  }

  if (type === "confirm" || type === "all") {
    const raw = await redis.lrange("bmi:confirm:log", 0, limit - 1);
    result.confirmCalls = parse(raw);
    result.confirmCount =
      result.confirmCalls && Array.isArray(result.confirmCalls) ? result.confirmCalls.length : 0;
  }

  return NextResponse.json(result);
}
