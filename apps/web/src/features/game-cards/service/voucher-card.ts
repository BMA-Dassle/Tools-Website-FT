/**
 * Redeem a BMI comp voucher as a DISPENSED Game Zone card.
 *
 * Standalone by design (owner 2026-07-29: "it could be possible that they want
 * these vouchers redeemed with nothing else"): no cart, no booking session, no
 * Square order, no BMI bill of our own. A guest can walk up holding only the
 * voucher. It also works unchanged with a full cart, because it never touches
 * the booking session.
 *
 * ORDER OF OPERATIONS — claim, then ledger row, and release the claim if the
 * row can't be written:
 *
 *   validate shape → peek at BMI (what IS this code?) → resolve the grant →
 *   CLAIM the code (atomic, global) → write the $0 ledger row → hand the kiosk
 *   a txnId to dispense against
 *
 * The claim comes first because it is the authorisation. Writing the ledger row
 * first would leave, on a lost claim race, a `charged`+`pending` row that the
 * reconcile cron would happily credit — a free card from a spent voucher. The
 * inverse (claim held, row missing) is safe: `loadCard` and the cron both
 * refuse a voucher row with no live claim, and the claim is released here.
 */

import { randomUUID } from "crypto";
import { getCenter } from "~/config/intercard-centers";
import {
  peekVoucher,
  voucherClientKeyForCenter,
} from "~/features/booking/service/bmi-voucher.server";
import { BMI_VOUCHER_RE } from "~/features/booking/service/voucher-redeem";
import { gameCardGrantFromCompName, type GameCardGrant } from "../vouchers/grants";
import { claimVoucher, releaseVoucherClaim } from "../data/voucher-claims-db";
import { markChargeFailed, startCompedTxn } from "../data/transactions-log";

export type VoucherRedeemRefusal =
  /** Not a BMI voucher number at all. */
  | "bad_format"
  /** BMI says the code doesn't exist / is expired / blocked. */
  | "unknown"
  /** BMI wouldn't tell us what it is (outage, or a center with no peek product). */
  | "unverifiable"
  /** A real voucher, but not a Game Zone card comp (or an unlisted denomination). */
  | "unsupported"
  /** One code bundling several products — we can't fulfil it whole here. */
  | "multi_item"
  /** Already redeemed (or in flight on another kiosk). */
  | "used"
  /** Our own storage failed — nothing was granted. */
  | "storage";

export type VoucherRedeemResult =
  | {
      ok: true;
      /** Ledger row to dispense + load against. */
      txnId: string;
      groupId: string;
      grant: GameCardGrant;
      /** BMI's raw comp name — logged / shown as a dim caption, never parsed twice. */
      compName: string;
    }
  | { ok: false; reason: VoucherRedeemRefusal; compName?: string };

/** BMI "not found" / expiry wording → a refusal the kiosk can phrase. */
function refusalFromBmiError(message: string | undefined): VoucherRedeemRefusal {
  const m = (message ?? "").toLowerCase();
  if (m.includes("not found") || m.includes("invalid")) return "unknown";
  if (m.includes("expire")) return "unknown";
  return "unverifiable";
}

export async function claimGameCardVoucher(input: {
  code: string;
  locationCode: number;
  center: string | null | undefined;
  kioskId?: string | null;
}): Promise<VoucherRedeemResult> {
  const code = input.code.trim().toUpperCase();
  if (!BMI_VOUCHER_RE.test(code)) return { ok: false, reason: "bad_format" };
  if (!getCenter(input.locationCode)) return { ok: false, reason: "unverifiable" };

  const clientKey = voucherClientKeyForCenter(input.center);

  // What IS this code? The peek opens a throwaway BMI order, applies the code to
  // read its comp line(s), then removes + cancels (probe-verified safe: codes
  // are not locked at apply). A comp we can't NAME cannot be granted — unlike
  // the cart rail, there is no later re-validation before value is handed over,
  // so "accept blind" is not an option on this path.
  const peek = await peekVoucher({ clientKey, code });
  if (!peek.ok) return { ok: false, reason: refusalFromBmiError(peek.errorMessage) };

  const names = peek.names?.filter((n) => n.trim().length > 0) ?? [];
  if (names.length === 0) return { ok: false, reason: "unverifiable" };

  // MULTI-ITEM voucher (owner question 2026-07-29: game zone card + laser tag on
  // one code). The two legs need opposite things — laser tag needs a BMI bill to
  // applyCode against, the card needs a dispense with no bill — and dispensing
  // is irreversible. Honouring one leg and dropping the other silently steals
  // value from the guest, so refuse the whole thing and send them to a human.
  // Logged with every name so a real mixed voucher shows up in Vercel logs and
  // we can build per-leg redemption against a real example (see
  // tasks/gamezone-voucher-plan.md §6).
  if (names.length > 1) {
    console.warn(
      `[gz-voucher] refused multi-item voucher ${code}: ${names.join(" | ")} — ` +
        `per-leg redemption is not built`,
    );
    return { ok: false, reason: "multi_item", compName: names.join(" + ") };
  }

  const compName = names[0];
  const grant = gameCardGrantFromCompName(compName);
  if (!grant) {
    // A real voucher for something else (race/laser/gel comps belong on the
    // cart rail), or a denomination outside the allowlist. Either way: nothing
    // is granted here, and the name is logged so an unmapped kind surfaces.
    console.warn(`[gz-voucher] not a game-card comp: ${code} — "${compName}"`);
    return { ok: false, reason: "unsupported", compName };
  }

  const txnId = randomUUID();
  const groupId = randomUUID();

  // AUTHORISE FIRST. A lost race here means the code is already spent.
  let claimed: Awaited<ReturnType<typeof claimVoucher>>;
  try {
    claimed = await claimVoucher({
      code,
      issuer: "bmi",
      compName,
      packageId: grant.packageId,
      txnId,
      locationCode: input.locationCode,
      clientKey,
      kioskId: input.kioskId ?? null,
    });
  } catch (err) {
    console.error("[gz-voucher] claim store unavailable:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "storage" };
  }
  if (!claimed.ok) return { ok: false, reason: "used", compName };

  // Then the durable $0 row the dispense loads against.
  try {
    await startCompedTxn({
      txnId,
      groupId,
      kind: "voucher",
      locationCode: input.locationCode,
      accountNumber: "", // read off the blank as it's dispensed
      packageId: grant.packageId,
      tokens: grant.tokens,
      bonusTokens: grant.bonusTokens,
      tpiTransactionId: `gzvoucher-${txnId}`,
      voucherCode: code,
    });
  } catch (err) {
    // Give the code back — nothing was dispensed, so the guest must be able to
    // try again (here or at Guest Services).
    await releaseVoucherClaim(code, txnId, "ledger row insert failed").catch(() => {});
    console.error("[gz-voucher] ledger insert failed:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "storage" };
  }

  return { ok: true, txnId, groupId, grant, compName };
}

/**
 * Hand a claimed voucher back. ONLY call this when NO card left the stacker —
 * the guest walked away at the insert prompt, or the dispenser faulted before
 * feeding. Once a blank has physically moved, the claim must stand even if the
 * credit failed: the row is `pending`, the reconcile cron drives it forward, and
 * releasing would dispense a SECOND card for one voucher.
 */
export async function releaseGameCardVoucher(input: {
  code: string;
  txnId: string;
  reason: string;
}): Promise<void> {
  const code = input.code.trim().toUpperCase();
  await releaseVoucherClaim(code, input.txnId, input.reason);
  // Take the row out of the recover-forward set so the cron can't credit a
  // voucher we just handed back.
  await markChargeFailed(input.txnId, `voucher released: ${input.reason}`);
}
