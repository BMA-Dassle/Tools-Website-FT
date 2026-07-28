/**
 * BMI voucher redemption — pure coverage math (no DB / no network).
 *
 * Redemption model, verified by the live probes of 2026-07-27
 * (scripts/bmi-voucher-probe.mts; findings in
 * tasks/future/kiosk-coupons-vouchers.md §4):
 *
 *   - BMI `order/applyCode` puts the voucher's comp product on the bill as a
 *     $0 LINE ("Race Comp ×1", voucherCode-stamped). It does NOT discount the
 *     existing lines — BMI nets the comp against the matching race line when
 *     the order is PROCESSED (owner-confirmed POS behavior).
 *   - Codes are NOT locked at apply (the same code applied to a second un-paid
 *     order was accepted), and cancelling the bill releases it — so an
 *     abandoned kiosk session can't burn a guest's voucher.
 *
 * OUR side must therefore charge as if one race is free: exactly like race
 * credits and kiosk race packs, the voucher-covered heat joins `excludedHeats`
 * so the same `buildRaceChargeLines` call prices the display AND the charge —
 * displayed can never drift from charged.
 *
 * Coverage rule (v1, deterministic): one comp line covers ONE single-race
 * heat assignment — the LOWEST-priced eligible one not already covered by
 * credits or packs (conservative until BMI confirms which line their netting
 * targets; the common voucher case is one racer / one race, where every rule
 * picks the same heat). Package and combo-pack heats are never covered — a
 * comp is a race, not a bundle.
 */

import type { BookingSession, RaceHeatAssignment, RaceItem } from "../state/types";
import { packageIdForCategory } from "../state/types";
import { getRaceProductById } from "./race-products";

/**
 * BMI voucher number shape: 12 strictly-alternating letter/digit pairs.
 * Confirmed invariant across a 32-code production batch (2026-07-27): letters
 * from a lookalike-free set, digits 2-9 (never 0/1). Shared by the kiosk scan
 * classifier AND the web checkout promo input so both surfaces route voucher
 * codes identically.
 */
export const BMI_VOUCHER_RE = /^(?:[A-Z][2-9]){12}$/;

/**
 * Voucher redemption ENTRY flag — OPT-IN, defaults OFF. Gates only the entry
 * points (kiosk code-entry accept + web checkout promo-input branch); the
 * pricing/charge seams key on `session.appliedVoucher` existing, which only a
 * gated entry can set, so no seam needs its own flag. Preview opt-in without
 * env: /kiosk/flow?kioskPromo=1&kioskVoucher=1. Set the literal "true" in
 * Vercel + redeploy for real exposure (NEXT_PUBLIC_* is build-baked). MUST
 * stay dark until the paid live smoke proves BMI's netting at processing
 * (probe 2026-07-27: the comp does NOT zero the race line at apply — the
 * owner-confirmed netting happens at settle, unverified by API).
 */
export function voucherRedeemEnabled(): boolean {
  return process.env.NEXT_PUBLIC_VOUCHER_REDEEM === "true";
}

/** Reserve-time hard fail: the session claims a voucher our server-side
 *  ledger never recorded for its bill. Never silently charge full price the
 *  guest didn't see — surface, let them retry or clear the voucher. */
export class VoucherNotVerifiedError extends Error {
  constructor(code: string) {
    super(`voucher ${code} is not verified for this order`);
    this.name = "VoucherNotVerifiedError";
  }
}

/** The session's scanned/applied voucher — defined in state/types (it lives
 *  on BookingSession); re-exported here so surfaces import one module. */
export type { AppliedVoucherState } from "../state/types";
import type { AppliedVoucherState } from "../state/types";

/** True once the voucher is actually ON a BMI bill (comp line exists). */
export function voucherIsApplied(v: AppliedVoucherState | null | undefined): boolean {
  return !!v && !v.pending && !v.error && !!v.billId && !!v.voucherOrderItemId;
}

/**
 * The heat assignments the session's voucher covers — mirror of
 * `redeemedHeatSet` (credits) and `computePackCoverage` (kiosk packs).
 * `excluded` = heats already covered by those two (they win first; a voucher
 * never doubles up on an already-$0 heat).
 *
 * Returns an empty set unless the voucher is APPLIED (pending/errored vouchers
 * price nothing — the guest sees full price until the comp line is real).
 */
export function voucherCoveredHeatSet(
  session: BookingSession,
  excluded: ReadonlySet<RaceHeatAssignment>,
): Set<RaceHeatAssignment> {
  if (!voucherIsApplied(session.appliedVoucher)) return new Set();

  let best: { heat: RaceHeatAssignment; price: number; start: string } | null = null;
  for (const item of session.items) {
    if (item.kind !== "race") continue;
    const race = item as RaceItem;
    for (const heat of race.heats) {
      if (!heat.heatId || excluded.has(heat)) continue;
      const category = heat.category ?? "adult";
      // Bundles are never comp targets.
      if (packageIdForCategory(race, category)) continue;
      const pid =
        heat.productId ?? (category === "adult" ? race.productIdAdult : race.productIdJunior);
      if (!pid) continue;
      const product = getRaceProductById(pid);
      if (!product || product.packType === "combo") continue;
      const start = heat.heatId;
      if (
        !best ||
        product.price < best.price ||
        (product.price === best.price && start < best.start)
      ) {
        best = { heat, price: product.price, start };
      }
    }
  }
  return best ? new Set([best.heat]) : new Set();
}

/**
 * Dollar amount the voucher takes off, derived by DIFFERENCING the same
 * line-builder the charge uses (never priced independently — the race-pack
 * covered-line idiom). `sumLines` = a closure over buildRaceChargeLines or
 * raceItemChargeLines with/without the extra exclusions.
 */
export function voucherCoveredAmount(
  covered: ReadonlySet<RaceHeatAssignment>,
  excluded: ReadonlySet<RaceHeatAssignment>,
  sumLines: (ex: Set<RaceHeatAssignment>) => number,
): number {
  if (covered.size === 0) return 0;
  const without = sumLines(new Set(excluded));
  const withCovered = sumLines(new Set([...excluded, ...covered]));
  return Math.max(0, Math.round((without - withCovered) * 100) / 100);
}
