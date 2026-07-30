/**
 * Native vouchers that cover a BOOKING (race / attraction items) — the
 * charge-time single-use claim.
 *
 * Unlike a game-zone item (dispensed on the Intercard rail), a race/laser item
 * reduces the booking charge: `planVoucherCoverage` excludes a heat or drops an
 * attraction unit, and THIS module makes that single-use. No Intercard txn, no
 * BMI bill — just the atomic per-item claim in `voucher_claims`.
 *
 * TIMING — claim at CHARGE, last moment (owner 2026-07-30). Scanning only adds
 * the voucher to the session; the destructive claim happens inside the reserve,
 * right before money moves, so:
 *   - abandoning checkout never burns a code,
 *   - the charge reflects exactly the coverage the guest saw (displayed==charged),
 *   - a code already spent by the time they pay HARD-FAILS the reserve rather
 *     than silently charging full price.
 *
 * IDEMPOTENT on the reserve's deterministic `baseKey`: a retry of the SAME
 * reserve re-recognises its own claim instead of colliding with it. That is the
 * one net-new correctness bit, and it's what `alreadyOurs` checks.
 */

import {
  claimVoucher,
  getClaimsByCode,
  releaseVoucherClaim,
} from "../data/voucher-claims-db";
import { logVoucherEvent } from "../data/vouchers-db";

/** One native voucher line applied to the booking (from session.appliedVouchers). */
export interface NativeCartVoucherRef {
  code: string;
  itemIndex: number;
  /** Coverage label ("Race" / "Laser Tag") — audit only; pricing already ran. */
  name?: string;
}

/** Stable per-(reserve,item) claim owner, so retries of one reserve are idempotent. */
function cartTxnId(baseKey: string, code: string, itemIndex: number): string {
  return `cart-${baseKey}-${code}-${itemIndex}`;
}

export type NativeCartClaimResult =
  | { ok: true; claimed: NativeCartVoucherRef[] }
  /** A code was already spent by SOMEONE ELSE — reserve must hard-fail on it. */
  | { ok: false; conflictCode: string };

/**
 * Claim every native cart voucher on the session for THIS reserve. All-or-fail:
 * on the first conflict it stops and reports the offending code, and the caller
 * releases whatever it took so a partial charge never lands.
 */
export async function claimNativeCartVouchers(args: {
  vouchers: NativeCartVoucherRef[];
  baseKey: string;
  locationCode: number;
}): Promise<NativeCartClaimResult> {
  const claimed: NativeCartVoucherRef[] = [];
  for (const v of args.vouchers) {
    const txnId = cartTxnId(args.baseKey, v.code, v.itemIndex);
    const res = await claimVoucher({
      code: v.code,
      itemIndex: v.itemIndex,
      issuer: "native",
      compName: v.name ?? null,
      packageId: `cart-${v.itemIndex}`, // not a game-card package; audit label only
      txnId,
      locationCode: args.locationCode,
      clientKey: null,
    });
    if (res.ok) {
      claimed.push(v);
      continue;
    }
    // Conflict: either a stale claim from THIS reserve (idempotent retry → OK)
    // or a genuine double-spend by another checkout (→ hard fail).
    if (await alreadyOurs(v, txnId)) {
      claimed.push(v);
      continue;
    }
    // Release what we took before bailing — never leave a half-claimed voucher.
    await releaseNativeCartVouchers({ vouchers: claimed, baseKey: args.baseKey }).catch(() => {});
    return { ok: false, conflictCode: v.code };
  }
  return { ok: true, claimed };
}

/** True when the live claim on (code,item) is one THIS reserve already made. */
async function alreadyOurs(v: NativeCartVoucherRef, txnId: string): Promise<boolean> {
  const rows = await getClaimsByCode(v.code).catch(() => []);
  return rows.some(
    (r) => r.itemIndex === v.itemIndex && r.status === "claimed" && r.txnId === txnId,
  );
}

/**
 * Hand native cart claims back — the booking didn't complete. Guarded on the
 * reserve's own txn id, so a rolled-back reserve can never release a code a
 * LATER checkout has since claimed.
 */
export async function releaseNativeCartVouchers(args: {
  vouchers: NativeCartVoucherRef[];
  baseKey: string;
}): Promise<void> {
  for (const v of args.vouchers) {
    await releaseVoucherClaim(v.code, cartTxnId(args.baseKey, v.code, v.itemIndex), "reserve rolled back").catch(
      () => {},
    );
  }
}

/** Audit stamp once the charge lands — the claim stays held (single use). */
export async function markNativeCartVouchersCharged(vouchers: NativeCartVoucherRef[]): Promise<void> {
  for (const v of vouchers) {
    await logVoucherEvent(v.code, "redeem", {
      itemIndex: v.itemIndex,
      surface: "booking",
      charged: true,
    }).catch(() => {});
  }
}
