import { NextRequest, NextResponse } from "next/server";
import { resolveAppliedPromo } from "~/features/discount-codes";
import { evaluateCode } from "~/features/discount-codes/evaluate";
import { getDiscountCodeByCode } from "~/features/discount-codes/data";
import type { DiscountDomain, ValidateReason } from "~/features/discount-codes/types";
import { squareLocationId } from "~/features/kiosk/service/square-terminal";
import { getClientIp } from "@/lib/admin-auth";
import redis from "@/lib/redis";

/**
 * POST /api/booking/v2/promo
 *
 * v2-booking-specific promo lookup. Wraps `resolveAppliedPromo` —
 * which returns the multi-domain `AppliedPromo` shape (NOT scoped to
 * one domain like `/api/discount-codes/validate` is).
 *
 * Two callers, two strictness levels:
 *
 * 1. `/book/v2` landing (web) — body `{ code }`. Deliberately LOOSE
 *    (no weekday/visit-date/location checks — the guest hasn't picked a
 *    date yet) and anti-enumeration (`{ valid: false }` never says why).
 *    This path is byte-identical to the pre-kiosk behavior.
 *
 * 2. Kiosk code entry — body `{ code, kiosk: { brand, center } }`. The
 *    kiosk is a WALK-UP surface (visit date = today, location = this
 *    venue), so validation is strict: weekday, visit-date window, and
 *    `allowed_locations` are all enforced per domain, with today
 *    computed server-side in ET (never trusted from the device). The
 *    response carries a `reason` on failure — an unattended guest has
 *    no cashier to ask, and the code was physically handed to them, so
 *    per-reason copy beats anti-enumeration here (the shared rate limit
 *    still applies). Domains that fail today are FILTERED from the
 *    returned promo (e.g. a weekday bowling+attractions code on a
 *    Saturday keeps only the domains still usable — none ⇒ invalid with
 *    the blocking reason).
 *
 * Rate-limited per IP + (for kiosks behind one venue NAT) per device.
 */

const RATE_LIMIT_WINDOW_SEC = 300; // 5 minutes
const RATE_LIMIT_MAX = 20;

interface KioskValidateCtx {
  brand?: string;
  center?: string;
  /** Stable device key (`<venue>:<n>`) — rate-limit granularity only. */
  deviceKey?: string;
}

/** Today's operating date in the venues' zone (ET), YYYY-MM-DD. */
function todayEtYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Reasons ranked most→least specific so a multi-domain failure surfaces the
 *  most actionable message (a wrong-weekday beats a generic wrong-domain). */
const REASON_RANK: ValidateReason[] = [
  "wrong_weekday",
  "wrong_date",
  "wrong_location",
  "wrong_product",
  "exhausted",
  "not_yet_active",
  "expired",
  "inactive",
  "unsupported_mechanic",
  "wrong_domain",
  "unknown",
];

export async function POST(req: NextRequest) {
  let body: { code?: string; kiosk?: KioskValidateCtx };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ valid: false }, { status: 400 });
  }

  const code = (body.code ?? "").trim().toUpperCase();
  if (!code) return NextResponse.json({ valid: false }, { status: 400 });

  // Rate-limit per IP — plus per kiosk device when identified, because a whole
  // venue's kiosks share one NAT'd IP and a busy Saturday must not exhaust the
  // shared bucket. Flaky Redis is non-fatal — better to serve a legit validate
  // than block customers when our cache is down.
  const ip = getClientIp(req) ?? "unknown";
  const limiterKey = body.kiosk?.deviceKey
    ? `discount:validate:kiosk:${body.kiosk.deviceKey}`
    : `discount:validate:${ip}`;
  try {
    const count = await redis.incr(limiterKey);
    if (count === 1) {
      await redis.expire(limiterKey, RATE_LIMIT_WINDOW_SEC);
    }
    if (count > RATE_LIMIT_MAX) {
      return NextResponse.json({ valid: false, reason: "rate_limited" }, { status: 429 });
    }
  } catch (err) {
    console.warn("[booking/v2/promo] redis rate-limit unavailable:", err);
  }

  const promo = await resolveAppliedPromo(code);

  // ── Loose web-landing path (unchanged behavior) ──
  if (!body.kiosk) {
    if (!promo) return NextResponse.json({ valid: false });
    return NextResponse.json({ valid: true, promo });
  }

  // ── Strict kiosk path ──
  if (!promo) {
    // resolveAppliedPromo nulls for unknown/inactive/expired/exhausted/
    // unsupported. Re-fetch the row once to name the reason for the guest.
    const row = await getDiscountCodeByCode(code).catch(() => null);
    const evaluated = evaluateCode(row, { code, domain: "racing" });
    const reason: ValidateReason = evaluated.valid ? "unknown" : evaluated.reason;
    // Domain never blocks here — the resolver's own reasons take precedence.
    return NextResponse.json({
      valid: false,
      reason: reason === "wrong_domain" ? "unknown" : reason,
    });
  }

  const row = await getDiscountCodeByCode(code).catch(() => null);
  const bookingDate = todayEtYmd();
  const locationId = squareLocationId(body.kiosk.center ?? "", body.kiosk.brand ?? "");

  const passing: DiscountDomain[] = [];
  const failures: ValidateReason[] = [];
  for (const domain of promo.domains) {
    const res = evaluateCode(row, { code, domain, locationId, bookingDate });
    if (res.valid) passing.push(domain);
    else failures.push(res.reason);
  }

  if (passing.length === 0) {
    const reason =
      REASON_RANK.find((r) => failures.includes(r)) ?? failures[0] ?? ("unknown" as const);
    return NextResponse.json({ valid: false, reason });
  }

  return NextResponse.json({
    valid: true,
    promo: { ...promo, domains: passing },
  });
}
