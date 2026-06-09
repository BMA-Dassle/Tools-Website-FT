import { NextRequest, NextResponse } from "next/server";
import { resolveAppliedPromo } from "~/features/discount-codes";
import { getClientIp } from "@/lib/admin-auth";
import redis from "@/lib/redis";

/**
 * POST /api/booking/v2/promo
 *
 * v2-booking-specific promo lookup. Wraps `resolveAppliedPromo` —
 * which returns the multi-domain `AppliedPromo` shape (NOT scoped to
 * one domain like `/api/discount-codes/validate` is).
 *
 * Used by the `/book/v2` landing page when the customer types or
 * `?code=`-seeds a code BEFORE picking an activity. The landing then
 * filters the offering tiles to scoped activities.
 *
 * Body: { code: string }
 * Response:
 *   { valid: true, promo: AppliedPromo }
 *   { valid: false }   // anti-enumeration — never leaks why
 *
 * Rate-limited per IP. Shares the same Redis key family as the
 * `/api/discount-codes/validate` endpoint so guessing attempts get
 * caught no matter which validator path they prefer.
 */

const RATE_LIMIT_WINDOW_SEC = 300; // 5 minutes
const RATE_LIMIT_MAX = 20;

export async function POST(req: NextRequest) {
  let body: { code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ valid: false }, { status: 400 });
  }

  const code = (body.code ?? "").trim().toUpperCase();
  if (!code) return NextResponse.json({ valid: false }, { status: 400 });

  // Rate-limit per IP. Flaky Redis is non-fatal — better to serve a legit
  // validate than block customers when our cache is down.
  const ip = getClientIp(req) ?? "unknown";
  try {
    const key = `discount:validate:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, RATE_LIMIT_WINDOW_SEC);
    }
    if (count > RATE_LIMIT_MAX) {
      return NextResponse.json({ valid: false }, { status: 429 });
    }
  } catch (err) {
    console.warn("[booking/v2/promo] redis rate-limit unavailable:", err);
  }

  const promo = await resolveAppliedPromo(code);
  if (!promo) return NextResponse.json({ valid: false });
  return NextResponse.json({ valid: true, promo });
}
