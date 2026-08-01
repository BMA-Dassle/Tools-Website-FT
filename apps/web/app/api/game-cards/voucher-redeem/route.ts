import type { NextRequest } from "next/server";
import { VoucherRedeemSchema } from "~/features/game-cards/schemas";
import {
  claimAnyVoucher,
  releaseAnyVoucher,
  validateAnyVoucher,
} from "~/features/game-cards/service/voucher-redeem-router";
import { getVoucherStatus } from "~/features/game-cards/service/native-voucher";
import { redeemVoucherToCard } from "~/features/game-cards/service/voucher-to-card";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";
import { getClientIp } from "@/lib/admin-auth";
import redis from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Game Zone voucher redemption — issuer-agnostic (`HPW…` = ours, the 24-char
 * alternating shape = BMI's; resolved from the code, no round-trip).
 *
 *   claim   → validate, take the GLOBAL single-use claim, return a $0 ledger row
 *             for the KIOSK to dispense + load against.
 *   to-card → WEB leg: credit the value onto a card the guest already holds.
 *   release → hand an unspent code back (nothing was delivered).
 *
 * A refusal is HTTP 200 + `{ok:false, reason}`: an unattended guest gets phrased
 * copy for every reason, and a rejected voucher is not a server error. Only
 * malformed requests 400.
 *
 * RATE LIMITED per IP. These are bearer instruments — 30^8 is a big space, but
 * an unthrottled endpoint is still an oracle, and the guessing surface is worth
 * closing since codes are individually emailed rather than bulk-published.
 */

const RATE_LIMIT_WINDOW_SEC = 300;
const RATE_LIMIT_MAX = 20;

async function rateLimited(req: NextRequest): Promise<boolean> {
  const ip = getClientIp(req) ?? "unknown";
  try {
    const key = `gzvoucher:redeem:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, RATE_LIMIT_WINDOW_SEC);
    return count > RATE_LIMIT_MAX;
  } catch (err) {
    // Redis down must not block a guest holding a legitimate voucher.
    console.warn("[game-cards/voucher-redeem] rate-limit unavailable:", err);
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = VoucherRedeemSchema.safeParse(body);
    if (!parsed.success) {
      throw new GameCardHttpError(400, "INVALID_INPUT", "Missing or invalid voucher details.");
    }

    if (parsed.data.action === "release") {
      await releaseAnyVoucher({
        code: parsed.data.code,
        txnId: parsed.data.txnId,
        reason: parsed.data.reason ?? "released by client",
      });
      return jsonOk({ released: true });
    }

    if (await rateLimited(req)) {
      return jsonOk({ ok: false, reason: "rate_limited" });
    }

    if (parsed.data.action === "status") {
      // Read-only per-item state for the confirmation page's Available/Used
      // chips — exactly what the public /v/{code} page renders server-side,
      // so no new exposure (the code IS the bearer instrument). Native only.
      const status = await getVoucherStatus(parsed.data.code);
      if (!status) return jsonOk({ ok: false, reason: "unknown" });
      return jsonOk({
        ok: true,
        expiresAt: status.expiresAt,
        expired: status.expired,
        voided: !!status.voidedAt,
        items: status.items.map((i) => ({ index: i.index, label: i.label, spent: i.spent })),
      });
    }

    if (parsed.data.action === "validate") {
      // Non-destructive: the guest is still adding vouchers to the basket.
      // Issuer-routed like claims — a PARKED BMI comp answers "unsupported"
      // here so the kiosk routes to Guest Services at scan time instead of
      // promising a card the dispenser will refuse. With the rail live, a
      // caller that names the tenant gets the real peeked grant.
      return jsonOk(
        await validateAnyVoucher({
          code: parsed.data.code,
          locationCode: parsed.data.locationCode,
          center: parsed.data.center,
        }),
      );
    }

    if (parsed.data.action === "to-card") {
      const result = await redeemVoucherToCard({
        code: parsed.data.code,
        accountNumber: parsed.data.accountNumber,
        locationCode: parsed.data.locationCode,
      });
      return jsonOk({ ...result });
    }

    const result = await claimAnyVoucher({
      code: parsed.data.code,
      locationCode: parsed.data.locationCode,
      center: parsed.data.center,
      kioskId: parsed.data.kioskId,
      source: "kiosk",
    });
    return jsonOk({ ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
