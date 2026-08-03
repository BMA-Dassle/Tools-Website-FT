import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { DealQuoteSchema } from "~/features/deals/schemas";
import { getDeal, type DealLocationKey } from "~/features/deals";
import { currentDealOffer } from "~/features/deals/service/offer";
import { quoteDeal, DealQuoteError } from "~/features/deals/service/quote";
import { getClientIp } from "@/lib/admin-auth";
import redis from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Price a deal pack for display. Square computes the tax, so Square also
 * supplies the number the buyer sees — the alternative is a second rounding
 * implementation on the client that eventually disagrees with the captured
 * amount ($45 at 6.5% is $2.925).
 *
 * Creates nothing: `/orders/calculate` is a dry run, so re-pricing on every
 * quantity change doesn't litter the merchant's order list with abandoned drafts.
 *
 * ALSO THE SOURCE OF THE LAUNCH-OFFER STATE. Both deal pages are
 * `revalidate = 3600`, so anything they render server-side can be an hour stale
 * — a packs-remaining counter cannot come from the page body. This route is
 * `force-dynamic` and already re-runs on every location and quantity change, so
 * it returns the resolved `offer` alongside the quote and the panel renders
 * the live numbers from there.
 *
 * Rate-limited generously — this fires on quantity and location changes, and it
 * reveals only a price we publish on the page anyway.
 */

const RATE_LIMIT_WINDOW_SEC = 300;
const RATE_LIMIT_MAX = 120;

async function rateLimited(req: NextRequest): Promise<boolean> {
  const ip = getClientIp(req) ?? "unknown";
  try {
    const key = `deals:quote:${ip}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, RATE_LIMIT_WINDOW_SEC);
    return n > RATE_LIMIT_MAX;
  } catch (err) {
    // Redis down must not stop a real buyer seeing a total.
    console.warn("[deals/quote] rate-limit unavailable:", err);
    return false;
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = DealQuoteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }
  if (await rateLimited(req)) {
    return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
  }

  const deal = getDeal(parsed.data.slug);
  const location = parsed.data.location as DealLocationKey;
  if (!deal || !deal.locations.includes(location)) {
    return NextResponse.json({ ok: false, error: "That deal isn't available." }, { status: 404 });
  }

  try {
    const offer = await currentDealOffer(deal);
    const quote = await quoteDeal({
      deal,
      location,
      qty: parsed.data.qty,
      unitPriceCents: offer.unitPriceCents,
    });
    return NextResponse.json({ ok: true, quote, offer });
  } catch (err) {
    if (err instanceof DealQuoteError) {
      // NOT_SELLABLE is the expected state before the owner supplies Square
      // catalog ids — surface it plainly so the page can say "coming soon"
      // rather than showing a broken total.
      return NextResponse.json(
        { ok: false, code: err.code, error: err.message },
        { status: err.code === "NOT_SELLABLE" ? 409 : 503 },
      );
    }
    console.error("[deals/quote] unexpected:", err);
    return NextResponse.json({ ok: false, error: "Could not price that." }, { status: 500 });
  }
}
