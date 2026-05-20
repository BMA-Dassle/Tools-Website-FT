import { NextRequest, NextResponse } from "next/server";
import {
  evaluateCode,
  getDiscountCodeByCode,
  type DiscountDomain,
  type ValidateContext,
} from "~/features/discount-codes";
import { getClientIp } from "@/lib/admin-auth";
import redis from "@/lib/redis";

/**
 * POST /api/discount-codes/validate
 *
 * Public endpoint called by the booking flows. Rate-limited per IP so a
 * brute-force guessing attempt can't enumerate valid codes — unknown codes
 * are bucketed alongside known-failed validations.
 *
 * Body:
 *   code:           string             — required
 *   domain:         "bowling" | "racing" | "attractions"  — required
 *   locationId?:    string             — Square location id (gates location-restricted codes)
 *   productSlug?:   string             — domain-specific product identifier
 *   bookingDate?:   "YYYY-MM-DD"       — weekday gate; omit for an early/loose check
 *
 * Response on success: see ValidateResult in features/discount-codes/types.ts.
 * Response on failure: { valid: false, reason } — never leaks whether the code exists.
 */

const RATE_LIMIT_WINDOW_SEC = 300; // 5 minutes
const RATE_LIMIT_MAX = 20;
const ALLOWED_DOMAINS = new Set<DiscountDomain>(["bowling", "racing", "attractions"]);

export async function POST(req: NextRequest) {
  let body: {
    code?: string;
    domain?: string;
    locationId?: string;
    productSlug?: string;
    bookingDate?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ valid: false, reason: "unknown" }, { status: 400 });
  }

  const code = (body.code ?? "").trim().toUpperCase();
  const domain = body.domain as DiscountDomain | undefined;

  if (!code || !domain || !ALLOWED_DOMAINS.has(domain)) {
    return NextResponse.json({ valid: false, reason: "unknown" }, { status: 400 });
  }

  // Rate-limit per IP. Failure to talk to Redis is non-fatal — we'd rather
  // serve a legit validate than block customers because Redis is flaky.
  const ip = getClientIp(req) ?? "unknown";
  try {
    const key = `discount:validate:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, RATE_LIMIT_WINDOW_SEC);
    }
    if (count > RATE_LIMIT_MAX) {
      return NextResponse.json({ valid: false, reason: "rate_limited" }, { status: 429 });
    }
  } catch (err) {
    console.warn("[discount/validate] redis rate-limit unavailable:", err);
  }

  const ctx: ValidateContext = {
    code,
    domain,
    locationId: body.locationId,
    productSlug: body.productSlug,
    bookingDate: body.bookingDate,
  };

  const row = await getDiscountCodeByCode(code);
  const result = evaluateCode(row, ctx);
  return NextResponse.json(result);
}
