/**
 * Game Zone card COMP grants — what a BMI voucher is worth on an Intercard
 * card. Pure: no DB, no network, importable from client and server.
 *
 * Why this file exists at all: a Game Zone comp is unlike every other BMI
 * voucher we redeem. Race / laser / gel comps ride `order/applyCode` and are
 * netted by BMI when the order is PROCESSED — the money leg does the work.
 * A "Complimentary 100 Token Game Card" has NO money leg: fulfillment is a
 * physical card out of the CRT-591 with Intercard value on it, which BMI
 * cannot see and cannot settle. So the grant (what to credit) has to be
 * derived on our side, from the only thing BMI hands us: the comp line's name.
 *
 * DERIVING FROM NAME TEXT IS DANGEROUS, so it is bounded twice:
 *
 *   1. STRICT shape. Only `Complimentary <N> Token Game Card` (case- and
 *      whitespace-insensitive, optional trailing prose) is recognised. The
 *      live gel-blaster comp proved BMI's "name" is free-form setup text
 *      ("Complimentary Gel Blasters. Redeem on a kiosk or at guest
 *      services."), so anything that isn't exactly this shape resolves to
 *      null and grants NOTHING.
 *   2. DENOMINATION ALLOWLIST. `<N>` must be one of the denominations we
 *      actually sell. A typo'd voucher setup ("1000000 Token") can therefore
 *      never mint a fortune — it fails closed instead.
 *
 * Verified against the owner's live BMI Office batch of 2026-07-29 (setup
 * "Complimentary 100 Token Game Card", memo "1 100 GZA", 5 codes, activation
 * fee credited, expires 2027-07-29).
 *
 * BUCKET CHOICE — comps land in the BONUS token bucket, never the purchased
 * one. Intercard tracks purchased vs promo value separately (see
 * `TokenPackage.bonusTokens`), which is exactly the distinction a comp wants:
 * refunds and revenue reports never see comped value as sold. 100 comped
 * bonus tokens = the $10 of play the owner described, at our 10¢/token rate.
 * `bonusCashDollars` wires the OTHER Intercard bucket (`<BonusCash>`) for the
 * day we want literal bonus cash instead — it is 0 for every shipped grant
 * because that SOAP field has never been exercised live (see
 * scripts/gz-voucher-bonuscash-probe.mts before turning it on).
 */

/**
 * Token denominations a comp voucher may grant. Mirrors the sellable packages
 * in ../constants.ts — a comp can only ever be worth something we also sell.
 */
export const COMP_TOKEN_DENOMINATIONS = [50, 100, 200, 300, 500, 1000] as const;

/** Synthetic package id prefix. Voucher grants are NOT in TOKEN_PACKAGES (that
 *  array is the sellable grid and a $0 tile must never render in it), so the
 *  ledger row carries `gzv-<tokens>` and every consumer resolves it back
 *  through `gameCardGrantFromPackageId` — one derivation, both directions. */
export const VOUCHER_PACKAGE_PREFIX = "gzv-";

export interface GameCardGrant {
  /** Persisted on the intercard_transactions row: `gzv-100`. */
  packageId: string;
  /** Purchased-token bucket. Always 0 for a comp. */
  tokens: number;
  /** Promo-token bucket — where comped value belongs. */
  bonusTokens: number;
  /** Intercard `<BonusCash>` dollars. 0 for every shipped grant (unproven rail). */
  bonusCashDollars: number;
  /** Short guest-facing label: "100 bonus tokens". */
  label: string;
}

/**
 * `Complimentary 100 Token Game Card` (+ optional trailing instructions).
 * Deliberately anchored at the start and deliberately narrow — see the header.
 */
const COMP_NAME_RE = /^\s*complimentary\s+(\d{1,7})\s+token\s+game\s+card\b/i;

function grantForTokens(tokens: number): GameCardGrant | null {
  if (!(COMP_TOKEN_DENOMINATIONS as readonly number[]).includes(tokens)) return null;
  return {
    packageId: `${VOUCHER_PACKAGE_PREFIX}${tokens}`,
    tokens: 0,
    bonusTokens: tokens,
    bonusCashDollars: 0,
    label: `${tokens} bonus tokens`,
  };
}

/**
 * BMI comp line name → what we credit. `null` = not a Game Zone card comp (or
 * a denomination we don't recognise) → the caller must grant NOTHING and say
 * so out loud. Never widen this without widening the allowlist too.
 */
export function gameCardGrantFromCompName(name: string | null | undefined): GameCardGrant | null {
  const m = COMP_NAME_RE.exec(name ?? "");
  if (!m) return null;
  return grantForTokens(Number(m[1]));
}

/**
 * Ledger `package_id` → grant. The inverse of the above, used by the load path
 * and the reconcile cron so a stored row re-derives its value from the SAME
 * allowlist that authorised it (a hand-edited `gzv-99999` row credits nothing).
 */
export function gameCardGrantFromPackageId(packageId: string | null | undefined): GameCardGrant | null {
  const id = (packageId ?? "").trim();
  if (!id.startsWith(VOUCHER_PACKAGE_PREFIX)) return null;
  const n = Number(id.slice(VOUCHER_PACKAGE_PREFIX.length));
  if (!Number.isInteger(n)) return null;
  return grantForTokens(n);
}

/** True for any ledger package id that came from a voucher grant. */
export function isVoucherPackageId(packageId: string | null | undefined): boolean {
  return (packageId ?? "").startsWith(VOUCHER_PACKAGE_PREFIX);
}
