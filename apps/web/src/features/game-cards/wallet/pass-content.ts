/**
 * What a voucher's wallet pass SAYS. Pure — no DB, no network, no clock beyond
 * what the caller passes in, so the whole projection is unit-testable.
 *
 * ── IT REUSES `vouchers/display.ts`, IT DOES NOT RE-DERIVE ───────────────────
 * The guest-facing wording rules already exist and were decided deliberately:
 * Game Zone value reads in DOLLARS ("$10 Game Card") because tokens are an
 * Intercard implementation detail, and attraction names come from the
 * ATTRACTIONS catalog so they match the rest of the site ("Gel Blasters", not a
 * de-hyphenated slug). Identical legs group into one counted row, spent legs
 * separately — the same `groupVoucherItems` the `/v/{code}` page renders.
 *
 * A pass that phrased any of that differently from `/v/{code}` would be two
 * answers to "what is this voucher worth" for the same guest looking at the same
 * voucher on two screens. So the ONLY thing this module adds is joining those
 * rows into one short line that fits an Apple Wallet field.
 *
 * ── ONE FIELD, LABELLED "REMAINING", IN EVERY STATE ─────────────────────────
 * An untouched voucher's remaining IS everything it was minted with, so the face
 * never switches wording and the template needs no conditional design. That one
 * decision is why partial redemption needs no second template.
 *
 * ── THE PASS IS A PROJECTION, NEVER THE LEDGER ──────────────────────────────
 * `voucher_claims` is the authority for what's been taken (one atomic CAS per
 * item is what makes redemption race-safe). This only renders it. A failed push
 * leaves stale text while the kiosk still redeems correctly — the safe direction.
 */

import type { VoucherItem } from "../data/vouchers-db";
import { formatVoucherExpiry, groupVoucherItems } from "../vouchers/display";

/** Per-item state, matching `VoucherItemState` from the voucher service. */
export interface RemainingInput {
  index: number;
  item: VoucherItem;
  spent: boolean;
}

/**
 * Apple starts eliding a field value around here, and a cut "2 × Laser Tag + $1…"
 * reads as broken rather than abbreviated. Past this we summarise deliberately.
 */
const MAX_VALUE_CHARS = 34;

/**
 * Can this leg actually be redeemed today? Game Zone value has a rail (kiosk
 * dispenser / web credit); attraction and race legs are MINTABLE but not yet
 * redeemable, so they must not hold a voucher open forever.
 *
 * Lives here because three callers need the same answer — the status page, this
 * projection, and the redeem picker — and it was spelled out inline in each.
 */
export function isRedeemableItem(item: VoucherItem): boolean {
  return item.kind === "gamezone";
}

/**
 * Zip minted items against the set of unavailable indexes. Index is item
 * identity everywhere in this system (see VoucherItem) — never reorder here.
 */
export function voucherItemStates(
  items: VoucherItem[],
  spentIndexes: ReadonlySet<number>,
): RemainingInput[] {
  return items.map((item, index) => ({ index, item, spent: spentIndexes.has(index) }));
}

/**
 * True once every REDEEMABLE leg is gone. A voucher whose only remaining legs
 * are attraction/race ones counts as finished for pass purposes — we cannot
 * redeem those, so keeping the pass live would promise a rail that doesn't exist.
 */
export function isFullySpent(states: RemainingInput[]): boolean {
  return states.filter((s) => isRedeemableItem(s.item)).every((s) => s.spent);
}

/** The unspent legs, in mint order. */
export function remainingItems(states: RemainingInput[]): RemainingInput[] {
  return states.filter((s) => !s.spent);
}

/**
 * Unspent legs → one short guest-facing line, worded and counted EXACTLY as
 * `/v/{code}` renders them (`{total} × {label}`, see VoucherRedeemView).
 *
 * Empty input returns "" — the caller decides whether that means "fully
 * redeemed" or "nothing to show", because those need different treatment.
 */
export function summariseRemaining(states: RemainingInput[]): string {
  const groups = groupVoucherItems(states.filter((s) => !s.spent));
  const parts = groups.map((g) => (g.total > 1 ? `${g.total} × ${g.label}` : g.label));
  const full = parts.join(" + ");
  if (full.length <= MAX_VALUE_CHARS || parts.length < 2) return full;
  // Summarise rather than let the OS cut a price or a product name in half.
  return `${parts[0]} + ${parts.length - 1} more`;
}

/** Guest-facing grouped code, matching the printed/emailed form. */
export function displayCode(code: string): string {
  return /^HPW[0-9A-Z]{8}$/.test(code) ? `HPW-${code.slice(3, 7)}-${code.slice(7)}` : code;
}

/**
 * The metaData map the PassKit template binds to. Keys are referenced as
 * `${meta.<key>}` in the template's barcode payload and field defaultValues, so
 * RENAMING A KEY HERE SILENTLY BLANKS A FIELD ON EVERY ISSUED PASS. The template
 * (scripts/passkit-voucher-template.mts) is the other half of this contract —
 * change both together.
 */
export interface VoucherPassMeta extends Record<string, string> {
  /** Grouped code, printed under the barcode as its altText. */
  code: string;
  /** Barcode payload. The kiosk already unwraps `/v/{code}` (code-entry/classify.ts). */
  redeemUrl: string;
  /** The "REMAINING" field. */
  voucherValue: string;
  expires: string;
  voucherKind: string;
  batchId: string;
}

export function buildPassMeta(args: {
  code: string;
  siteOrigin: string;
  remaining: RemainingInput[];
  expiresAt: string | null;
  kind: string;
  batchId: string | null;
}): VoucherPassMeta {
  return {
    code: displayCode(args.code),
    redeemUrl: `${args.siteOrigin.replace(/\/$/, "")}/v/${args.code}`,
    // A fully-redeemed voucher gets the coupon flipped to REDEEMED rather than
    // an empty field, but the value still has to say something if a render
    // races that flip.
    voucherValue: summariseRemaining(args.remaining) || "Fully redeemed",
    // Same ET formatter the /v page uses — a voucher expiring 11:59 PM ET must
    // not read as the next day for a guest whose phone is on another timezone.
    expires: formatVoucherExpiry(args.expiresAt) ?? "No expiry",
    voucherKind: args.kind,
    batchId: args.batchId ?? "",
  };
}
