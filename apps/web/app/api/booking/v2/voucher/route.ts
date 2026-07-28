import { NextRequest, NextResponse } from "next/server";
import {
  applyVoucherToBill,
  peekVoucher,
  removeVoucherFromBill,
  voucherClientKeyForCenter,
} from "~/features/booking/service/bmi-voucher.server";
import { BMI_VOUCHER_RE } from "~/features/booking/service/voucher-redeem";
import { getClientIp } from "@/lib/admin-auth";
import redis from "@/lib/redis";

/**
 * POST /api/booking/v2/voucher — apply / remove a BMI voucher on a live bill.
 *
 * SURFACE-AGNOSTIC by design (owner 2026-07-27: "these same vouchers need to
 * be usable online — wire it where web reutilizes the same code"): the kiosk
 * code-entry screen and the web checkout promo input both call this route,
 * and both ride the same server service + Neon audit ledger the reserve
 * verifies against.
 *
 *   apply:  { action: "apply", billId, code, center?, source? }
 *           → { ok: true, name, voucherOrderItemId } | { ok: false, reason }
 *   remove: { action: "remove", billId, code, voucherOrderItemId, center? }
 *           → { ok: boolean }
 *
 * Safety posture: applying is NON-destructive — BMI does not lock a code at
 * apply (probe-verified 2026-07-27), and the comp line only turns into money
 * movement inside unified-reserve, which re-verifies coverage against OUR
 * ledger row (never the client session). Guest-facing kiosk/web route → no
 * device auth, same as the promo validator; rate-limited per IP.
 */

const RATE_LIMIT_WINDOW_SEC = 300;
const RATE_LIMIT_MAX = 30;

interface VoucherBody {
  action?: "apply" | "remove" | "peek";
  billId?: string;
  code?: string;
  voucherOrderItemId?: string;
  center?: string;
  source?: "kiosk" | "web";
}

export async function POST(req: NextRequest) {
  let body: VoucherBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "bad_request" }, { status: 400 });
  }

  const billId = (body.billId ?? "").trim();
  const code = (body.code ?? "").trim().toUpperCase();
  if (!BMI_VOUCHER_RE.test(code)) {
    return NextResponse.json({ ok: false, reason: "bad_request" }, { status: 400 });
  }
  // peek needs no bill; apply/remove do.
  if (body.action !== "peek" && !/^\d+$/.test(billId)) {
    return NextResponse.json({ ok: false, reason: "bad_request" }, { status: 400 });
  }

  const ip = getClientIp(req) ?? "unknown";
  try {
    const key = `voucher:apply:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, RATE_LIMIT_WINDOW_SEC);
    if (count > RATE_LIMIT_MAX) {
      return NextResponse.json({ ok: false, reason: "rate_limited" }, { status: 429 });
    }
  } catch (err) {
    console.warn("[booking/v2/voucher] redis rate-limit unavailable:", err);
  }

  const clientKey = voucherClientKeyForCenter(body.center);

  if (body.action === "peek") {
    // Identity/validity feedback at SCAN time — a throwaway order learns the
    // comp name, then is removed + cancelled (codes don't lock at apply).
    const res = await peekVoucher({ clientKey, code });
    if (!res.ok) {
      const msg = (res.errorMessage ?? "").toLowerCase();
      const reason = msg.includes("not found")
        ? "unknown"
        : msg.includes("expired")
          ? "expired"
          : msg.includes("used") || msg.includes("redeemed")
            ? "used"
            : "generic";
      return NextResponse.json({ ok: false, reason });
    }
    return NextResponse.json({ ok: true, name: res.name });
  }

  if (body.action === "remove") {
    const voucherOrderItemId = (body.voucherOrderItemId ?? "").trim();
    if (!/^\d+$/.test(voucherOrderItemId)) {
      return NextResponse.json({ ok: false, reason: "bad_request" }, { status: 400 });
    }
    const res = await removeVoucherFromBill({ clientKey, billId, voucherOrderItemId, code });
    return NextResponse.json(res);
  }

  const res = await applyVoucherToBill({
    clientKey,
    billId,
    code,
    source: body.source === "web" ? "web" : "kiosk",
  });
  if (!res.ok) {
    console.warn(`[booking/v2/voucher] apply failed for bill ${billId}: ${res.errorMessage}`);
    // BMI's message names the code ("Voucher (code: …) is not found") — map to
    // a small reason set the surfaces translate for guests.
    const msg = (res.errorMessage ?? "").toLowerCase();
    const reason = msg.includes("not found")
      ? "unknown"
      : msg.includes("expired")
        ? "expired"
        : msg.includes("used") || msg.includes("redeemed")
          ? "used"
          : "generic";
    return NextResponse.json({ ok: false, reason });
  }
  return NextResponse.json({
    ok: true,
    name: res.name,
    voucherOrderItemId: res.voucherOrderItemId,
  });
}
