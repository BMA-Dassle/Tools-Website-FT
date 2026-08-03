import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { DealPurchaseSchema } from "~/features/deals/schemas";
import { purchaseDeal, DealPurchaseError } from "~/features/deals/service/purchase";
import { getClientIp } from "@/lib/admin-auth";
import redis from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Charge + mint + email in one request; the email leg can be slow. */
export const maxDuration = 120;

/**
 * Buy a deal pack. Thin shell: parse, rate-limit, delegate.
 *
 * The service owns the ordering that matters (persist before charge, soft-fail
 * after capture) — see `~/features/deals/service/purchase`. This route's only
 * jobs are to reject malformed input, throttle, and map typed failures onto
 * status codes the buy panel can act on.
 *
 * Rate limit is TIGHT compared to the quote route: this one moves money, and a
 * legitimate buyer needs it a handful of times at most. Unlike the quote
 * limiter it FAILS CLOSED — if Redis is unreachable we would rather a buyer
 * retries than leave an unthrottled charge endpoint open.
 */

const RATE_LIMIT_WINDOW_SEC = 600;
const RATE_LIMIT_MAX = 8;

async function rateLimited(req: NextRequest): Promise<boolean> {
  const ip = getClientIp(req) ?? "unknown";
  try {
    const key = `deals:purchase:${ip}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, RATE_LIMIT_WINDOW_SEC);
    return n > RATE_LIMIT_MAX;
  } catch (err) {
    console.error("[deals/purchase] rate-limit unavailable — failing closed:", err);
    return true;
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = DealPurchaseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Please check the form and try again." },
      { status: 400 },
    );
  }
  if (await rateLimited(req)) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Please wait a few minutes and try again." },
      { status: 429 },
    );
  }

  try {
    const result = await purchaseDeal(parsed.data);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof DealPurchaseError) {
      return NextResponse.json(
        { ok: false, code: err.code, error: err.message },
        { status: err.status },
      );
    }
    // Anything unexpected here happened BEFORE capture (the service soft-fails
    // everything after), so it is safe to tell the buyer nothing was charged.
    console.error("[deals/purchase] unexpected:", err);
    return NextResponse.json(
      { ok: false, error: "Something went wrong and you were not charged. Please try again." },
      { status: 500 },
    );
  }
}
