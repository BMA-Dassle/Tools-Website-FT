/**
 * ONE entry point for redeeming a Game Zone voucher, whoever issued it.
 *
 * Issuer is decided LOCALLY from the code's shape — `HPW…` is ours, the 24-char
 * alternating shape is BMI's — so no network call is spent working out which
 * system to ask (see vouchers/codes.ts for why the prefix is universal).
 *
 *   native → the `vouchers` registry answers; no external dependency at all.
 *   bmi    → `peekVoucher` asks BMI what the code is, then the comp name is
 *            mapped through the denomination allowlist.
 *
 * Both converge on the SAME shape — a held single-use claim plus a $0 ledger row
 * — because everything downstream (dispense, credit, recover-forward cron) is
 * issuer-agnostic and must stay that way.
 *
 * WEB vs KIOSK fulfilment:
 *   kiosk → `accountNumber` empty; a blank is dispensed and its account read off
 *           the card, then credited.
 *   web   → `accountNumber` is the card the guest ALREADY holds; there is no
 *           dispense, just a $0 credit onto their own card.
 */

import { isNativeVoucherCode } from "../vouchers/codes";
import { BMI_VOUCHER_RE } from "~/features/booking/service/voucher-redeem";
import {
  claimNativeVoucher,
  releaseNativeVoucher,
  validateNativeVoucher,
  type NativeVoucherRefusal,
} from "./native-voucher";
import {
  claimGameCardVoucher,
  releaseGameCardVoucher,
  resolveGameCardComp,
  type VoucherRedeemRefusal,
} from "./voucher-card";
import type { VoucherIssuer } from "../data/voucher-claims-db";

export type AnyVoucherRefusal = VoucherRedeemRefusal | NativeVoucherRefusal;

/** The BMI game-card comp rail ships dark (owner 2026-07-29: "leave BMI vouchers
 *  for game cards for another day"). ONE gate shared by the claim, the basket
 *  validate, and the coupon screen's peek routing, so the surfaces can never
 *  disagree about whether the rail is live. Set GZ_VOUCHER_BMI=1 to wake it up. */
export function gzVoucherBmiRailLive(): boolean {
  return process.env.GZ_VOUCHER_BMI === "1";
}

export type RedeemClaim =
  | {
      ok: true;
      issuer: VoucherIssuer;
      txnId: string;
      groupId: string;
      /** What lands on the card. */
      grant: { tokens: number; bonusTokens: number; bonusCashDollars: number };
      /** Short label for the screen ("100 bonus tokens"). */
      label: string;
    }
  | { ok: false; issuer: VoucherIssuer | null; reason: AnyVoucherRefusal };

/** Which system owns this code, from its shape alone. */
export function voucherIssuerFor(code: string): VoucherIssuer | null {
  if (isNativeVoucherCode(code)) return "native";
  if (BMI_VOUCHER_RE.test(code.trim().toUpperCase())) return "bmi";
  return null;
}

export async function claimAnyVoucher(input: {
  code: string;
  locationCode: number;
  center?: string | null;
  /** WEB only: credit the card the guest already holds (no dispense). */
  accountNumber?: string;
  kioskId?: string | null;
  source: "kiosk" | "web";
}): Promise<RedeemClaim> {
  const issuer = voucherIssuerFor(input.code);
  if (!issuer) return { ok: false, issuer: null, reason: "bad_format" };

  if (issuer === "native") {
    const res = await claimNativeVoucher({
      code: input.code,
      locationCode: input.locationCode,
      accountNumber: input.accountNumber,
      kioskId: input.kioskId,
      source: input.source,
    });
    if (!res.ok) return { ok: false, issuer, reason: res.reason };
    return {
      ok: true,
      issuer,
      txnId: res.txnId,
      groupId: res.groupId,
      grant: res.grant,
      label: `${res.grant.bonusTokens} bonus tokens`,
    };
  }

  // BMI-issued comps are PARKED — see gzVoucherBmiRailLive. The code ships
  // dormant rather than being deleted (it's probe-verified work), but a
  // BMI-shaped scan must not reach a live BMI call on a path nobody has smoked.
  if (!gzVoucherBmiRailLive()) {
    return { ok: false, issuer, reason: "unsupported" };
  }
  // Only the kiosk can redeem these: fulfilment is a dispense and the comp's
  // value has to be read back off BMI, so there is no web leg.
  if (input.source === "web") return { ok: false, issuer, reason: "unsupported" };
  const res = await claimGameCardVoucher({
    code: input.code,
    locationCode: input.locationCode,
    center: input.center,
    kioskId: input.kioskId,
  });
  if (!res.ok) return { ok: false, issuer, reason: res.reason };
  return {
    ok: true,
    issuer,
    txnId: res.txnId,
    groupId: res.groupId,
    grant: {
      tokens: res.grant.tokens,
      bonusTokens: res.grant.bonusTokens,
      bonusCashDollars: res.grant.bonusCashDollars,
    },
    label: res.grant.label,
  };
}

/**
 * Scan-time validate, whoever issued the code — claims NOTHING on either path.
 * Native answers from the `vouchers` registry (response shape unchanged: `items`);
 * BMI answers from the same non-destructive peek→allowlist resolution the claim
 * uses, returned as a `label` for the basket row. A BMI code while the rail is
 * dark refuses `unsupported` — the same answer its claim would give — instead of
 * the `bad_format` lie the native-only validate used to tell.
 */
export async function validateAnyVoucher(input: {
  code: string;
  locationCode?: number;
  center?: string | null;
}): Promise<Record<string, unknown>> {
  const issuer = voucherIssuerFor(input.code);
  if (!issuer) return { ok: false, issuer: null, reason: "bad_format" };
  if (issuer === "native") {
    return { issuer, ...(await validateNativeVoucher(input.code)) };
  }
  if (!gzVoucherBmiRailLive()) return { ok: false, issuer, reason: "unsupported" };
  // The peek needs a center to pick the BMI tenant — a basket that can claim
  // always has one; refuse rather than guess (a wrong tenant misreads the comp).
  if (input.locationCode === undefined) return { ok: false, issuer, reason: "unverifiable" };
  const res = await resolveGameCardComp({
    code: input.code,
    locationCode: input.locationCode,
    center: input.center,
  });
  if (!res.ok) return { ok: false, issuer, reason: res.reason };
  return { ok: true, issuer, label: res.grant.label };
}

/** Release by issuer — same "nothing was delivered" rule on both paths. */
export async function releaseAnyVoucher(input: {
  code: string;
  txnId: string;
  reason: string;
}): Promise<void> {
  const issuer = voucherIssuerFor(input.code);
  if (issuer === "native") return releaseNativeVoucher(input);
  return releaseGameCardVoucher(input);
}
