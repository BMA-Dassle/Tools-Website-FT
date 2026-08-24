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

import { syncVoucherPass } from "../wallet/voucher-pass";
import {
  claimVoucher,
  getClaimsByCode,
  listStaleCartClaims,
  markVoucherClaimSpent,
  releaseVoucherClaim,
} from "../data/voucher-claims-db";
import { getVoucher, hasChargedRedeemEvent, logVoucherEvent } from "../data/vouchers-db";
import { looksLikeGrouponCode } from "~/features/groupon/codes";
import { findGrouponUnit } from "~/features/groupon/data/groupon-units-db";

/**
 * Which registry owns this code's cart legs.
 *
 * Groupon legs ride THIS rail rather than getting their own, because everything
 * that makes cart coverage correct already lives here: the pre-claim validation,
 * equivalent-leg substitution, idempotency on the reserve's baseKey, release on
 * rollback, the spent stamp and the stale sweep. A parallel Groupon
 * implementation would be a second writer for `voucher_claims` and would drift
 * from this one the first time any of those behaviours changed.
 *
 * Only two things actually differ per issuer: which table proves the voucher is
 * real, and whether there is a wallet pass to mirror. Both are switched below;
 * the destructive claim is identical.
 */
function issuerOf(code: string): "native" | "groupon" {
  return looksLikeGrouponCode(code) ? "groupon" : "native";
}

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
    // GROUPON: proof of existence is our own `groupon_units` row, written at
    // scan time from Groupon's GET. There is no expiry or void to check —
    // Groupon owns the voucher's lifecycle and we only ever hold the remainder,
    // so a row that exists IS the entitlement. Fails closed identically.
    if (issuerOf(code) === "groupon") {
      try {
        if (!(await findGrouponUnit(code))) {
          return { ok: false, conflictCode: code, reason: "unknown" };
        }
      } catch (err) {
        console.error("[voucher-cart] groupon ledger read failed:", err);
        return { ok: false, conflictCode: code, reason: "unknown" };
      }
      continue;
    }
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
      issuer: issuerOf(v.code),
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
  await syncPassesFor(claimed);
  return { ok: true, claimed };
}

/**
 * Mirror remaining value onto each affected wallet pass, once per CODE — a
 * booking can spend several legs of one voucher and PassKit only needs telling
 * once. Never throws (syncVoucherPass swallows its own errors) and no-ops for
 * vouchers the guest never added to a wallet, which is most of them.
 */
async function syncPassesFor(refs: NativeCartVoucherRef[]): Promise<void> {
  for (const code of new Set(refs.map((r) => r.code))) {
    // Groupon vouchers have no row in OUR voucher registry and so no wallet
    // pass to mirror. Skipping is not an optimisation: syncVoucherPass would
    // read a voucher that does not exist.
    if (issuerOf(code) === "groupon") continue;
    await syncVoucherPass(code);
  }
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
  // Legs came back — the pass has to go back UP, or the guest sees value they
  // still hold reported as gone.
  await syncPassesFor(args.vouchers);
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
    // Event log lives in the native voucher registry. A Groupon code has no row
    // there, so the spent-stamp above is the only evidence for that issuer —
    // which is why the stale sweep must not release a groupon claim on the
    // strength of a missing event (see sweepStaleCartClaims).
    if (issuerOf(v.code) === "native") {
      await logVoucherEvent(v.code, "redeem", {
        itemIndex: v.itemIndex,
        surface: "booking",
        charged: true,
      }).catch(() => {});
    }
  }
  // Terminal for these legs. If this was the LAST redeemable leg, the sync flips
  // the coupon to REDEEMED so the pass stops looking live.
  await syncPassesFor(args.vouchers);
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
      // GROUPON claims are never released here. The two-part protection this
      // sweep relies on is status='spent' (primary) plus a charged event in the
      // native registry (secondary, for a MISSED stamp) — and a Groupon code has
      // no row in that registry, so `hasChargedRedeemEvent` is always false for
      // one. Releasing on that would hand a leg back that a captured booking had
      // already spent, i.e. let the guest spend it twice. A stuck leg is
      // recoverable by hand; a double-spent one is not.
      if (issuerOf(row.code) === "groupon") {
        console.warn(
          `[groupon] stale cart claim NOT released (no event-log evidence for this issuer) ` +
            `code=${row.code} item=${row.itemIndex} txn=${row.txnId} — release by hand if the booking never captured`,
        );
        continue;
      }
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
        // The sweep is the OTHER writer that restores legs. Without this an
        // abandoned checkout leaves the pass permanently under-reporting.
        await syncVoucherPass(row.code);
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
