import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { lookupGiftCardForSplit } from "~/features/kiosk/service/split-tenders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kiosk gift-card lookup for split tenders: POST { seed, gan } →
 * { lookupToken, balanceCents, last4 }. The GAN arrives from the kiosk QR
 * scanner / MSR / on-screen keyboard; the response NEVER carries the raw
 * gftc: id or full GAN — the single-use lookupToken is what the client hands
 * back to /api/kiosk/deposit-tenders.
 *
 * Anti-enumeration (the kiosk is unauthenticated):
 *  - the seed must resolve a LIVE terminal anchor (minting one requires a full
 *    kiosk prepare — random callers can't walk the GAN space);
 *  - per-IP sliding rate limit + a per-seed failed-lookup cap;
 *  - "not found", "internal deposit card", and "inactive" all return the SAME
 *    generic error (no oracle on which GANs exist).
 */

const FAILED_CAP = 10;
const failedKey = (seed: string) => `kiosk:gclookup:failed:${seed}`;

async function rateLimited(req: NextRequest): Promise<boolean> {
  try {
    const fwd = req.headers.get("x-forwarded-for");
    const ip = (fwd ? fwd.split(",")[0] : null)?.trim() || "unknown";
    const key = `rl:gc-lookup:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 300);
    return count > 30; // generous for a shared-NAT venue, hostile to enumeration
  } catch {
    return false; // fail open — the anchor binding is the real gate
  }
}

export async function POST(req: NextRequest) {
  if (await rateLimited(req)) {
    return NextResponse.json({ error: "Too many lookups — wait a moment" }, { status: 429 });
  }
  let body: { seed?: string; splitToken?: string; gan?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const seed = (body.seed ?? "").trim();
  const splitToken = (body.splitToken ?? "").trim();
  const gan = (body.gan ?? "").trim();
  if (!seed || !splitToken || !gan) {
    return NextResponse.json({ error: "seed, splitToken, and gan required" }, { status: 400 });
  }

  // Per-seed failed-lookup cap — a guest fat-fingers a couple of times; a
  // scraper burns the session long before the GAN space yields anything.
  try {
    const fails = Number((await redis.get(failedKey(seed))) ?? 0);
    if (fails >= FAILED_CAP) {
      return NextResponse.json(
        { error: "Too many attempts — please see the front desk" },
        { status: 429 },
      );
    }
  } catch {
    /* fail open */
  }

  const result = await lookupGiftCardForSplit({ seed, splitToken, gan });
  if (!result.ok) {
    if (result.error === "no-session" || result.error === "already-captured") {
      return NextResponse.json({ error: "Session not found" }, { status: 403 });
    }
    try {
      const n = await redis.incr(failedKey(seed));
      if (n === 1) await redis.expire(failedKey(seed), 3600);
    } catch {
      /* non-fatal */
    }
    // Deliberately uniform copy — never disclose WHY a card is unusable.
    const msg =
      result.error === "zero-balance"
        ? "This gift card has no remaining balance."
        : "We couldn't use that gift card — check the number or see the front desk.";
    return NextResponse.json({ error: msg }, { status: 422 });
  }
  return NextResponse.json({
    ok: true,
    lookupToken: result.lookupToken,
    balanceCents: result.balanceCents,
    last4: result.last4,
  });
}
