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
import { GROUPON_LONG_CODE_RE, looksLikeGrouponCode } from "~/features/groupon/codes";
import { findGrouponUnit } from "~/features/groupon/data/groupon-units-db";
import { validateGrouponForKiosk } from "~/features/groupon/service/kiosk-validate.server";
import {
  claimGrouponGameZone,
  type GrouponClaimRefusal,
} from "~/features/groupon/service/claim.server";

export type AnyVoucherRefusal = VoucherRedeemRefusal | NativeVoucherRefusal | GrouponClaimRefusal;

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
  // Groupon's UNAMBIGUOUS long form only. Its 7-/8-character short form is
  // deliberately NOT matched here: `SUMMER26` is also 8 alphanumerics, and
  // `89895632` is also a bare game-card barcode, so shape cannot decide it and
  // this function is a shape-only authority. Use `resolveVoucherIssuer` for the
  // short form — it settles the ambiguity with a ledger lookup instead.
  if (GROUPON_LONG_CODE_RE.test(code.trim().toUpperCase())) return "groupon";
  return null;
}

/**
 * Which system owns this code, resolving the ambiguous cases with DATA.
 *
 * Groupon's 7-/8-character short code cannot be told from a same-length promo,
 * or — when all digits — from a game-card barcode, by shape alone. But by the time
 * anything is claimed we have already validated the voucher and written a
 * `groupon_units` row, so the existence of that row IS the answer. A promo code
 * has no row and falls through to whatever it was before.
 *
 * Fails OPEN to "not Groupon": if the ledger read throws, a promo code must
 * still behave like a promo rather than becoming a broken Groupon claim.
 */
export async function resolveVoucherIssuer(code: string): Promise<VoucherIssuer | null> {
  const byShape = voucherIssuerFor(code);
  if (byShape) return byShape;
  if (!looksLikeGrouponCode(code)) return null;
  try {
    return (await findGrouponUnit(code)) ? "groupon" : null;
  } catch (err) {
    console.error(
      "[voucher-router] groupon ledger read failed, treating as non-groupon:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Non-destructive validate, issuer-routed the same way claims are. Validate
 * used to be native-only, so a BMI-shaped comp read as `bad_format` AFTER the
 * coupon screen had already promised the guest a card — and BMI comps are
 * PARKED anyway (owner 2026-07-29, `GZ_VOUCHER_BMI`), so the kiosk needs the
 * honest answer at SCAN time to route the guest to Guest Services instead.
 *
 * With the park flag lifted, a caller that can name the tenant (locationCode +
 * center — the Game Zone basket does) validates through the SAME non-destructive
 * peek→allowlist resolution the claim uses (resolveGameCardComp), so the basket
 * row shows the real grant. A bare-code caller still gets the optimistic ok —
 * either way the claim stays the destructive authority.
 */
export async function validateAnyVoucher(
  input: string | { code: string; locationCode?: number; center?: string | null },
): Promise<{ ok: boolean; reason?: string; label?: string; items?: unknown[] }> {
  const { code, locationCode, center } =
    typeof input === "string" ? { code: input, locationCode: undefined, center: undefined } : input;
  const issuer = await resolveVoucherIssuer(code);
  if (issuer === "native") return validateNativeVoucher(code);
  if (issuer === "groupon") {
    const res = await validateGrouponForKiosk(code);
    return res.ok
      ? { ok: true, label: res.label, items: res.items }
      : { ok: false, reason: res.reason };
  }
  if (issuer === "bmi") {
    if (!gzVoucherBmiRailLive()) return { ok: false, reason: "unsupported" };
    if (locationCode === undefined) return { ok: true, label: "Game Zone card comp" };
    const res = await resolveGameCardComp({ code, locationCode, center });
    return res.ok ? { ok: true, label: res.grant.label } : { ok: false, reason: res.reason };
  }
  return { ok: false, reason: "bad_format" };
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
  const issuer = await resolveVoucherIssuer(input.code);
  if (!issuer) return { ok: false, issuer: null, reason: "bad_format" };

  if (issuer === "groupon") {
    const res = await claimGrouponGameZone({
      code: input.code,
      locationCode: input.locationCode,
      kioskId: input.kioskId,
      accountNumber: input.accountNumber,
      source: input.source,
    });
    if (!res.ok) return { ok: false, issuer: "groupon", reason: res.reason };
    return {
      ok: true,
      issuer: "groupon",
      txnId: res.txnId,
      groupId: res.groupId,
      grant: res.grant,
      label: res.label,
    };
  }

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
