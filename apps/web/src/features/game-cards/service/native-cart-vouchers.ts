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
  listStaleCartClaims,
  markVoucherClaimSpent,
  releaseVoucherClaim,
} from "../data/voucher-claims-db";
import { getVoucher, hasChargedRedeemEvent, logVoucherEvent } from "../data/vouchers-db";

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
  | { ok: false; conflictCode: string; reason?: "spent" | "expired" | "voided" | "unknown" };

/**
 * Claim every native cart voucher on the session for THIS reserve. All-or-fail:
 * on the first conflict it stops and reports the offending code, and the caller
 * releases whatever it took so a partial charge never lands.
 */
export async function claimNativeCartVouchers(args: {
  vouchers: NativeCartVoucherRef[];
  baseKey: string;
  locationCode: number;
  /** Per-ref equivalent legs (same code, IDENTICAL coverage name) the plan did
   *  NOT allocate, keyed `${code}:${itemIndex}`. A stale session can carry a
   *  leg another checkout has since spent while its twin sits unspent (leg 1
   *  vs leg 3 on the V2 voucher — owner repro 2026-08-01, W56657): the claim
   *  falls over to the twin instead of hard-failing the booking. */
  substitutes?: Map<string, NativeCartVoucherRef[]>;
}): Promise<NativeCartClaimResult> {
  const claimed: NativeCartVoucherRef[] = [];

  /**
   * VALIDATE THE VOUCHER ROW BEFORE CLAIMING ANYTHING.
   *
   * `claimVoucher` is only an atomic compare-and-set on `voucher_claims` — it
   * knows nothing about the voucher itself. Without this, an EXPIRED or VOIDED
   * code still covered a cart at charge time, because the entry surfaces are the
   * only place expiry was ever checked and a session outlives them: a 12-month
   * pack that lapsed mid-checkout still discounted, and a voucher voided from the
   * admin board (which is how a refund claws the value back) still worked.
   *
   * Checked once per distinct code — a multi-leg voucher shares one row — and the
   * cheap read happens before the destructive step, same ordering as
   * `claimNativeVoucher`.
   */
  const distinctCodes = Array.from(new Set(args.vouchers.map((v) => v.code)));
  for (const code of distinctCodes) {
    let row: Awaited<ReturnType<typeof getVoucher>>;
    try {
      row = await getVoucher(code);
    } catch (err) {
      // Fail CLOSED: an unverifiable voucher must not silently reduce a charge.
      console.error("[voucher-cart] registry read failed:", err);
      return { ok: false, conflictCode: code, reason: "unknown" };
    }
    if (!row) return { ok: false, conflictCode: code, reason: "unknown" };
    if (row.voidedAt) return { ok: false, conflictCode: code, reason: "voided" };
    if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) {
      return { ok: false, conflictCode: code, reason: "expired" };
    }
  }

  const claimOne = async (v: NativeCartVoucherRef): Promise<boolean> => {
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
    // Conflict: either a stale claim from THIS reserve (idempotent retry → OK)
    // or a genuine double-spend by another checkout (→ caller decides).
    return res.ok || (await alreadyOurs(v, txnId));
  };
  for (const v of args.vouchers) {
    if (await claimOne(v)) {
      claimed.push(v);
      continue;
    }
    // The named leg is gone — try each equivalent unallocated twin before
    // failing. Same code + same coverage name, so the priced coverage is
    // byte-identical; only WHICH ledger row gets spent changes.
    const subs = (args.substitutes?.get(`${v.code}:${v.itemIndex}`) ?? []).filter(
      (s) => !claimed.some((c) => c.code === s.code && c.itemIndex === s.itemIndex),
    );
    let substituted = false;
    for (const sub of subs) {
      if (await claimOne(sub)) {
        console.log(
          `[native-cart-vouchers] leg ${v.itemIndex} of ${v.code} already spent — substituted equivalent leg ${sub.itemIndex}`,
        );
        claimed.push(sub);
        substituted = true;
        break;
      }
    }
    if (substituted) continue;
    // Release what we took before bailing — never leave a half-claimed voucher.
    await releaseNativeCartVouchers({ vouchers: claimed, baseKey: args.baseKey }).catch(() => {});
    return { ok: false, conflictCode: v.code };
  }
  return { ok: true, claimed };
}

/** True when the live claim on (code,item) is one THIS reserve already made.
 *  'spent' counts too: a replay of a reserve that already captured must
 *  re-recognise its own claim (Square replays idempotently downstream), not
 *  hard-fail the guest with "voucher used". */
async function alreadyOurs(v: NativeCartVoucherRef, txnId: string): Promise<boolean> {
  const rows = await getClaimsByCode(v.code).catch(() => []);
  return rows.some(
    (r) =>
      r.itemIndex === v.itemIndex &&
      (r.status === "claimed" || r.status === "spent") &&
      r.txnId === txnId,
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
    await releaseVoucherClaim(
      v.code,
      cartTxnId(args.baseKey, v.code, v.itemIndex),
      "reserve rolled back",
    ).catch(() => {});
  }
}

/**
 * Stamp once the charge lands: the claim goes TERMINAL ('spent' — never
 * releasable, which is what lets the stale sweep free abandoned checkouts) and
 * the event log records the redemption. Both writes are soft-fail (never fail a
 * captured booking on a stamp), but each miss is logged loudly because they are
 * the two pieces of evidence the sweep consults before releasing a claim.
 */
export async function markNativeCartVouchersCharged(args: {
  vouchers: NativeCartVoucherRef[];
  baseKey: string;
}): Promise<void> {
  for (const v of args.vouchers) {
    const txnId = cartTxnId(args.baseKey, v.code, v.itemIndex);
    await markVoucherClaimSpent(v.code, txnId)
      .then((moved) => {
        if (!moved)
          console.error(
            `[native-voucher] spent-stamp matched no claimed row (code=${v.code} item=${v.itemIndex}) — sweep must rely on the event log`,
          );
      })
      .catch((err) =>
        console.error(
          `[native-voucher] spent-stamp failed (code=${v.code} item=${v.itemIndex}):`,
          err instanceof Error ? err.message : err,
        ),
      );
    await logVoucherEvent(v.code, "redeem", {
      itemIndex: v.itemIndex,
      surface: "booking",
      charged: true,
    }).catch(() => {});
  }
}

export interface StaleCartClaimSweepSummary {
  candidates: number;
  released: number;
  /** Claims with capture evidence in the event log — healed to 'spent', not released. */
  healedSpent: number;
  errors: number;
}

/**
 * Free cart claims stranded by a checkout that never captured (guest walked
 * away, charge declined and was never retried, serverless freeze between claim
 * and release). Age threshold is far past any retry horizon; a claim whose
 * charge DID capture is protected twice — by the 'spent' status (skipped in the
 * query) and by the event-log check here (healed forward, never released).
 */
export async function sweepStaleCartClaims(args: {
  minAgeMinutes: number;
  dryRun: boolean;
}): Promise<StaleCartClaimSweepSummary> {
  const summary: StaleCartClaimSweepSummary = {
    candidates: 0,
    released: 0,
    healedSpent: 0,
    errors: 0,
  };
  const stale = await listStaleCartClaims(args.minAgeMinutes);
  summary.candidates = stale.length;
  for (const row of stale) {
    try {
      if (await hasChargedRedeemEvent(row.code, row.itemIndex)) {
        // The charge captured but the spent-stamp was missed — finish the stamp.
        if (!args.dryRun) await markVoucherClaimSpent(row.code, row.txnId);
        summary.healedSpent++;
        continue;
      }
      console.warn(
        `[native-voucher] releasing stale cart claim code=${row.code} item=${row.itemIndex} ` +
          `txn=${row.txnId} age>${args.minAgeMinutes}m${args.dryRun ? " (dry-run)" : ""}`,
      );
      if (!args.dryRun) {
        await releaseVoucherClaim(row.code, row.txnId, "stale cart claim sweep");
      }
      summary.released++;
    } catch (err) {
      summary.errors++;
      console.error(
        `[native-voucher] stale-claim sweep failed for ${row.code}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return summary;
}
