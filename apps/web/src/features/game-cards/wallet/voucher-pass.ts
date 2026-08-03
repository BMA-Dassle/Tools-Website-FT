/**
 * Voucher → Apple/Google Wallet pass. The only module that knows both a voucher
 * and PassKit.
 *
 * ── NEON IS THE SOURCE OF TRUTH; THIS IS A DOWNSTREAM MIRROR ─────────────────
 * Every function here is safe to fail. `vouchers` + `voucher_claims` already
 * answer "what is this worth" and "what's left" without PassKit existing, and
 * nothing in the redemption path may block, unwind, or change behaviour because
 * a pass write failed. A stale pass is an acceptable outcome; a guest stuck at a
 * kiosk is not.
 *
 * ── ISSUE LAZILY, ON THE TAP ─────────────────────────────────────────────────
 * PassKit bills single-use passes AT ISSUANCE, not at install. Pre-creating a
 * coupon when we mint a voucher would bill us for every voucher whose email is
 * never opened. So nothing is created until a guest actually asks for the pass,
 * and `syncVoucherPass` no-ops for vouchers that have never been added.
 *
 * ── IDEMPOTENT WITHOUT A LOCK ────────────────────────────────────────────────
 * `externalId` is our own `HPW…` code, and PassKit rejects a duplicate
 * externalId within a campaign with **409** (verified live 2026-08-03). So
 * create-then-recover-on-409 is safe under concurrency: two simultaneous taps
 * cannot mint two billed passes, and no reservation row or advisory lock is
 * needed. `passkit_coupon_id` on the voucher is a cache, not the authority —
 * `getCouponByExternalId` can always rebuild it.
 *
 * ── THE RULES. Do not relax these without reading why they exist. ────────────
 *
 * 1. UPDATE THE PASS INLINE, IN THE SAME REQUEST THAT MOVED THE CLAIM. Never a
 *    cron, never a queue, never "the next sweep will catch it". A guest who just
 *    handed over a leg at a kiosk is still standing there holding the phone —
 *    if the pass still shows the old value when they look down, they believe
 *    they were charged twice. `syncVoucherPass` is therefore called from the
 *    redemption paths themselves (native-voucher redeem/release/void,
 *    native-cart-vouchers claim/release/charged), all awaited in-request. The
 *    only cron that touches it is the stale-claim sweep, and that is because a
 *    sweep RELEASE is itself a claim movement — it syncs inline too.
 *
 * 2. EVERY WRITER OF CLAIM STATE SYNCS. Take, release, spend, void — all four.
 *    A new claim writer that forgets this leaves the pass permanently wrong in
 *    one direction, and under-reporting is the dangerous one: it looks to the
 *    guest like value vanished. If you add a path that touches
 *    `voucher_claims`, it calls this module before it returns.
 *
 * 3. A SYNC FAILURE IS NEVER A REDEMPTION FAILURE. Every export here swallows
 *    its own errors. Neon already recorded the truth; the pass is a rendering.
 *    A stale pass self-heals on the guest's next tap of Add to Wallet (which
 *    re-pushes current state) and the kiosk never trusted the pass anyway.
 *
 * 4. NEVER READ THE PASS TO DECIDE ANYTHING. It is write-only from our side.
 *    `voucher_claims` is the single authority for what has been taken — one
 *    atomic CAS per item is what makes redemption race-safe, and a second
 *    opinion held on someone's phone would be a second writer.
 *
 * 5. NO PASS, NO CALL. Skip on `passkit_coupon_id IS NULL` rather than asking
 *    PassKit whether one exists. Most guests never add a pass, and this runs on
 *    the redemption hot path.
 */

// Data layer + the pure projection only. Importing the voucher SERVICE here
// would close a cycle (native-voucher → wallet → native-voucher), which is why
// the item-state projection lives in pass-content.ts and is shared instead.
import { getVoucher, logVoucherEvent, setVoucherPassId } from "../data/vouchers-db";
import { spentItemIndexes } from "../data/voucher-claims-db";
import { PASSKIT_VOUCHER } from "~/config/passkit";
import { isPassKitConfigured, passkit, PassKitError, passUrls } from "~/lib/api/passkit";
import {
  buildPassMeta,
  isFullySpent,
  remainingItems,
  voucherItemStates,
  type VoucherPassMeta,
} from "./pass-content";

/** Kill switch, not a gate: a merged feature is ON. Set to "false" to stop all
 *  PassKit traffic in an emergency without a deploy. */
export function walletPassesEnabled(): boolean {
  return process.env.PASSKIT_SYNC !== "false" && isPassKitConfigured();
}

function siteOrigin(): string {
  return process.env.NEXT_PUBLIC_SITE_URL || "https://headpinz.com";
}

interface CouponResponse {
  id: string;
  externalId?: string;
  status?: "UNREDEEMED" | "REDEEMED";
}

/** Why we refused to hand out a pass. The caller turns these into guest copy. */
export type PassRefusal =
  | "not_found"
  | "voided"
  | "expired"
  | "fully_redeemed"
  | "disabled"
  | "error";

export type IssueResult =
  | { ok: true; passId: string; urls: ReturnType<typeof passUrls> }
  | { ok: false; refusal: PassRefusal };

/**
 * Build the metadata for a voucher's CURRENT state. One place, so the issue path
 * and the sync path can never disagree about what the pass should say.
 */
async function metaFor(
  code: string,
): Promise<{ meta: VoucherPassMeta; fullySpent: boolean; expired: boolean } | null> {
  const [row, spent] = await Promise.all([getVoucher(code), spentItemIndexes(code)]);
  if (!row) return null;
  const states = voucherItemStates(row.items, spent);
  return {
    meta: buildPassMeta({
      code: row.code,
      siteOrigin: siteOrigin(),
      remaining: remainingItems(states),
      expiresAt: row.expiresAt,
      kind: row.kind,
      batchId: row.batchId,
    }),
    fullySpent: isFullySpent(states),
    // Resolved here, server-side, exactly like VoucherStatus.expired — reading
    // the clock further down would give two answers in one request.
    expired: !!row.expiresAt && Date.parse(row.expiresAt) <= Date.now(),
  };
}

/** Recover an existing pass by our own code. Null when there isn't one. */
async function findByExternalId(code: string): Promise<CouponResponse | null> {
  try {
    return await passkit<CouponResponse>(
      "GET",
      `/coupon/singleUse/coupon/externalId/${PASSKIT_VOUCHER.campaignId}/${encodeURIComponent(code)}`,
    );
  } catch (err) {
    if (err instanceof PassKitError && err.isNotFound) return null;
    throw err;
  }
}

/**
 * Get the guest a wallet pass for `code`, creating it on first ask.
 *
 * Refuses a voided, expired or fully-redeemed voucher rather than minting a pass
 * that promises value it can't deliver. This check is the whole reason we own
 * this path instead of putting a static PassKit distribution link in the email:
 * a link signed at mint time cannot know the voucher was voided afterwards.
 */
export async function issueVoucherPass(code: string): Promise<IssueResult> {
  if (!walletPassesEnabled()) return { ok: false, refusal: "disabled" };

  const row = await getVoucher(code);
  if (!row) return { ok: false, refusal: "not_found" };
  if (row.voidedAt) return { ok: false, refusal: "voided" };

  const built = await metaFor(code);
  if (!built) return { ok: false, refusal: "not_found" };
  if (built.expired) return { ok: false, refusal: "expired" };
  if (built.fullySpent) return { ok: false, refusal: "fully_redeemed" };

  try {
    let coupon: CouponResponse;
    try {
      coupon = await passkit<CouponResponse>("POST", "/coupon/singleUse/coupon", {
        campaignId: PASSKIT_VOUCHER.campaignId,
        offerId: PASSKIT_VOUCHER.offerId,
        // OUR code is the external id — that is what makes this idempotent.
        externalId: row.code,
        ...(row.expiresAt ? { expiryDate: new Date(row.expiresAt).toISOString() } : {}),
        metaData: built.meta,
      });
      await logVoucherEvent(code, "send", { walletPass: "issued", passId: coupon.id });
    } catch (err) {
      if (!(err instanceof PassKitError) || !err.isDuplicate) throw err;
      // Already issued — an earlier tap, or a concurrent one that won the race.
      const existing = await findByExternalId(row.code);
      if (!existing) throw err;
      coupon = existing;
      // Re-taps are also a free self-heal: push current state in case a sync
      // was missed while the guest wasn't looking.
      await passkit("PUT", "/coupon/singleUse/coupon", {
        id: coupon.id,
        metaData: built.meta,
      }).catch(() => undefined);
    }

    // Cache the id so the sync path can skip PassKit entirely for vouchers that
    // have no pass. Best-effort — findByExternalId can always rebuild it.
    await setVoucherPassId(code, coupon.id).catch(() => undefined);
    return { ok: true, passId: coupon.id, urls: passUrls(coupon.id) };
  } catch (err) {
    console.error("[voucher-pass] issue failed:", err instanceof Error ? err.message : err);
    return { ok: false, refusal: "error" };
  }
}

/**
 * Mirror the voucher's current state onto its pass. Call after ANY claim state
 * change — take, release, or spend.
 *
 * Fire-and-forget by contract: never awaited on a guest's critical path in a way
 * that can fail their redemption, and never throws.
 *
 * PARTIAL REDEMPTION. PassKit's CouponStatus is binary (UNREDEEMED | REDEEMED),
 * so partial state cannot live in it. While any redeemable leg is unclaimed the
 * coupon stays UNREDEEMED and the REMAINING field carries what's left; only when
 * the last leg goes do we flip it to REDEEMED.
 *
 * RELEASES MUST COME BACK THROUGH HERE. A released claim (abandoned checkout)
 * restores a leg, so the pass has to go back UP. Miss that and the pass
 * under-reports forever and the guest believes they lost value.
 */
export async function syncVoucherPass(code: string): Promise<void> {
  if (!walletPassesEnabled()) return;
  try {
    const row = await getVoucher(code);
    // No pass was ever added → nothing to mirror, and no reason to ask PassKit.
    // This is the common case: most guests never tap Add to Wallet.
    if (!row?.passkitCouponId) return;

    const built = await metaFor(code);
    if (!built) return;

    await passkit("PUT", "/coupon/singleUse/coupon", {
      id: row.passkitCouponId,
      metaData: built.meta,
    });

    if (built.fullySpent) {
      // Terminal. Also what swaps in the offer's after-redeem template, so a
      // spent voucher stops looking live.
      await passkit("PUT", "/coupon/singleUse/coupon/redeem", { id: row.passkitCouponId });
    }
    await logVoucherEvent(code, built.fullySpent ? "redeem" : "scan", {
      walletPass: built.fullySpent ? "redeemed" : "updated",
      remaining: built.meta.voucherValue,
    });
  } catch (err) {
    // Swallowed on purpose. A stale pass is recoverable — the guest's next tap
    // re-syncs it, and the kiosk never trusted the pass in the first place.
    console.error("[voucher-pass] sync failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Void the pass when we void the voucher. Best-effort, same contract as sync.
 *
 * THERE IS NO REST `voidCoupon`. The gRPC service defines one, but every REST
 * spelling answers 501 Method Not Allowed (probed 2026-08-03:
 * `…/coupon/void`, `…/coupon/invalidate`, `…/coupon/expire`,
 * `…/coupon/voidCoupon`, `DELETE …/coupon/{id}`). So we void with the two
 * mechanisms that ARE proven: say so in the REMAINING field, and back-date the
 * expiry so Wallet greys the pass out by itself.
 *
 * Deliberately NOT `redeemCoupon` — that would tell the guest they used it,
 * which is a different and wrong story.
 */
export async function voidVoucherPass(code: string): Promise<void> {
  if (!walletPassesEnabled()) return;
  try {
    const row = await getVoucher(code);
    if (!row?.passkitCouponId) return;
    const built = await metaFor(code);
    await passkit("PUT", "/coupon/singleUse/coupon", {
      id: row.passkitCouponId,
      metaData: { ...(built?.meta ?? {}), voucherValue: "No longer valid" },
      // Immediate expiry: Wallet dims an expired pass without us needing a void
      // endpoint. Also starts PassKit's own 90-day record cleanup.
      expiryDate: new Date().toISOString(),
    });
    await logVoucherEvent(code, "void", { walletPass: "expired" });
  } catch (err) {
    console.error("[voucher-pass] void failed:", err instanceof Error ? err.message : err);
  }
}
