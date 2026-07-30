/**
 * OUR OWN Game Zone vouchers — mint, validate, void.
 *
 * Web/kiosk only (owner 2026-07-29): these codes exist nowhere but our database,
 * so they are redeemable on our own surfaces and BMI Office cannot see or honour
 * them. That is the point — no external dependency, no consume endpoint to wait
 * on, and the value is a fact we wrote down at mint time instead of prose we
 * have to parse at redemption.
 *
 * Two fulfilments, one voucher:
 *   kiosk → dispense a NEW card and credit it (CRT-591 rail)
 *   web   → credit a card the guest ALREADY holds (the /reload rail at $0)
 *
 * Validation order matters and is intentionally boring: existence → voided →
 * expired → claim. The claim is LAST because it is the destructive step; every
 * cheap reason to refuse is checked first so a bad code never burns.
 */

import { randomInt, randomUUID } from "crypto";
import {
  generateVoucherCode,
  isNativeVoucherCode,
  normalizeVoucherCode,
} from "../vouchers/codes";
import {
  gameZoneGrant,
  getVoucher,
  insertVoucher,
  logVoucherEvent,
  voidVoucher,
  voucherItemLabel,
  type VoucherGrantConfig,
  type VoucherItem,
  type VoucherKind,
  type VoucherRow,
} from "../data/vouchers-db";
import { claimVoucher, releaseVoucherClaim, spentItemIndexes } from "../data/voucher-claims-db";
import { markChargeFailed, startCompedTxn } from "../data/transactions-log";
import { VOUCHER_PACKAGE_PREFIX } from "../vouchers/grants";

/** Denominations the mint UI offers. Mirrors the sellable token packages. */
export const NATIVE_GRANT_DENOMINATIONS = [50, 100, 200, 300, 500, 1000] as const;

export type NativeVoucherRefusal =
  | "bad_format"
  | "unknown"
  | "voided"
  | "expired"
  /** Every Game Zone item on this voucher is already spent. */
  | "used"
  /** The voucher is live, but has no Game Zone item to redeem here (e.g. it only
   *  carries a laser-tag item, whose cart-coverage rail isn't built yet). */
  | "not_redeemable"
  | "storage";

/** How many code collisions we tolerate before giving up on a mint. */
const MINT_COLLISION_RETRIES = 5;

export interface MintedVoucher {
  code: string;
  items: VoucherItem[];
}

/** One Game Zone item worth `bonusTokens`, the only kind redeemable today. */
export function gameZoneItem(bonusTokens: number): VoucherItem {
  return {
    kind: "gamezone",
    tokens: 0, // comped value never lands in the purchased bucket
    bonusTokens,
    bonusCashDollars: 0, // unproven Intercard rail — see the bonus-cash probe
  };
}

/** Per-item redemption state — what staff and the guest see. */
export interface VoucherItemState {
  index: number;
  item: VoucherItem;
  label: string;
  spent: boolean;
  /** False when we can mint it but can't yet redeem it (attraction/race). */
  redeemable: boolean;
}

export interface VoucherStatus {
  code: string;
  items: VoucherItemState[];
  expiresAt: string | null;
  voidedAt: string | null;
  /** Resolved HERE (server) rather than at render time — reading the clock
   *  during a render is impure and would differ between passes. */
  expired: boolean;
  /** True once every REDEEMABLE item is spent. */
  fullySpent: boolean;
}

/**
 * What is left on a voucher. A multi-item voucher is partially redeemable
 * forever — the guest may take the game card today and come back for the rest —
 * so "is it used?" is only ever answered per item.
 */
export async function getVoucherStatus(code: string): Promise<VoucherStatus | null> {
  const c = normalizeVoucherCode(code);
  const voucher = await getVoucher(c);
  if (!voucher) return null;
  const spent = await spentItemIndexes(c);
  const items: VoucherItemState[] = voucher.items.map((item, index) => ({
    index,
    item,
    label: voucherItemLabel(item),
    spent: spent.has(index),
    redeemable: item.kind === "gamezone",
  }));
  return {
    code: c,
    items,
    expiresAt: voucher.expiresAt,
    voidedAt: voucher.voidedAt,
    expired: !!voucher.expiresAt && Date.parse(voucher.expiresAt) <= Date.now(),
    fullySpent: items.filter((i) => i.redeemable).every((i) => i.spent),
  };
}

export type ValidateResult =
  | { ok: true; label: string; remainingGameZoneItems: number }
  | { ok: false; reason: NativeVoucherRefusal };

/**
 * Check a code WITHOUT claiming it — the scan step of the kiosk basket, where a
 * guest adds several vouchers before committing to anything.
 *
 * Claiming at scan time would be wrong twice over: a guest still choosing would
 * be holding codes hostage, and abandoning the screen would burn them (we'd
 * have to chase every one with a release). So scanning only VALIDATES, and the
 * destructive claim happens per card at dispense time. Two kiosks can therefore
 * both validate the same code and only one will win the claim — which is the
 * correct outcome, decided by the atomic CAS rather than by who scanned first.
 *
 * Cheap enough to do per scan because it reads OUR database; there is no
 * external call anywhere on this path.
 */
export async function validateNativeVoucher(code: string): Promise<ValidateResult> {
  const c = normalizeVoucherCode(code);
  if (!isNativeVoucherCode(c)) return { ok: false, reason: "bad_format" };
  let status: Awaited<ReturnType<typeof getVoucherStatus>>;
  try {
    status = await getVoucherStatus(c);
  } catch (err) {
    console.error("[native-voucher] validate failed:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "storage" };
  }
  if (!status) return { ok: false, reason: "unknown" };
  if (status.voidedAt) return { ok: false, reason: "voided" };
  if (status.expired) return { ok: false, reason: "expired" };
  const gz = status.items.filter((i) => i.redeemable);
  if (gz.length === 0) return { ok: false, reason: "not_redeemable" };
  const unspent = gz.filter((i) => !i.spent);
  if (unspent.length === 0) return { ok: false, reason: "used" };
  return {
    ok: true,
    label: unspent[0].label,
    remainingGameZoneItems: unspent.length,
  };
}

/**
 * Mint a batch. Each code is generated from a CSPRNG and inserted with
 * ON CONFLICT DO NOTHING; a collision retries with a fresh code rather than
 * overwriting, because an overwrite would silently re-point a live voucher
 * somebody is already holding.
 */
export async function mintVouchers(args: {
  count: number;
  /** The lines of value each minted voucher carries (>=1). */
  items: VoucherItem[];
  batchLabel?: string | null;
  expiresAt?: string | null;
  issuedSource?: string;
  createdBy?: string | null;
}): Promise<{ batchId: string; vouchers: MintedVoucher[] }> {
  const count = Math.max(1, Math.min(500, Math.floor(args.count)));
  const items = args.items;
  if (items.length === 0) throw new Error("a voucher needs at least one item");
  // Game Zone denominations stay on the allowlist even though we mint them
  // ourselves: it keeps comped value to amounts we actually sell, and it is the
  // same guard the load path re-applies when resolving `gzv-<n>`.
  for (const item of items) {
    if (
      item.kind === "gamezone" &&
      !(NATIVE_GRANT_DENOMINATIONS as readonly number[]).includes(item.bonusTokens)
    ) {
      throw new Error(`unsupported denomination: ${item.bonusTokens}`);
    }
    if (item.kind !== "gamezone" && item.qty < 1) {
      throw new Error(`item qty must be at least 1`);
    }
  }
  const kind: VoucherKind = items.every((i) => i.kind === "gamezone") ? "gamezone" : "mixed";
  const batchId = randomUUID();
  const vouchers: MintedVoucher[] = [];

  for (let i = 0; i < count; i++) {
    let inserted = false;
    for (let attempt = 0; attempt < MINT_COLLISION_RETRIES && !inserted; attempt++) {
      const code = generateVoucherCode((max) => randomInt(max));
      inserted = await insertVoucher({
        code,
        kind,
        items,
        batchId,
        batchLabel: args.batchLabel ?? null,
        issuedSource: args.issuedSource ?? "admin",
        issuedTo: null,
        expiresAt: args.expiresAt ?? null,
        createdBy: args.createdBy ?? null,
      });
      if (inserted) {
        vouchers.push({ code, items });
        await logVoucherEvent(
          code,
          "mint",
          { batchId, items, batchLabel: args.batchLabel },
          args.createdBy,
        );
      }
    }
    if (!inserted) throw new Error("could not mint a unique code after retries");
  }
  return { batchId, vouchers };
}

export type NativeClaimResult =
  | {
      ok: true;
      txnId: string;
      groupId: string;
      grant: VoucherGrantConfig;
      /** Ledger package id, so the load path re-derives value the same way. */
      packageId: string;
      /** WHICH line of the voucher was spent — the rest stay redeemable. */
      itemIndex: number;
      voucher: VoucherRow;
      /** Items still unspent after this claim (for "you still have…" copy). */
      remaining: VoucherItemState[];
    }
  | { ok: false; reason: NativeVoucherRefusal };

/**
 * Validate one of OUR codes and take its single-use claim, returning a $0 ledger
 * row to fulfil against.
 *
 * `accountNumber` is set on the WEB path (credit a card the guest already
 * holds); the kiosk leaves it empty and fills it in from the blank it dispenses.
 * Either way the claim is taken BEFORE the ledger row exists, so a lost race
 * can never leave a creditable orphan behind.
 */
export async function claimNativeVoucher(input: {
  code: string;
  locationCode: number;
  accountNumber?: string;
  kioskId?: string | null;
  source: "kiosk" | "web";
}): Promise<NativeClaimResult> {
  const code = normalizeVoucherCode(input.code);
  if (!isNativeVoucherCode(code)) return { ok: false, reason: "bad_format" };

  let voucher: VoucherRow | null;
  try {
    voucher = await getVoucher(code);
  } catch (err) {
    console.error("[native-voucher] registry read failed:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "storage" };
  }
  if (!voucher) return { ok: false, reason: "unknown" };
  if (voucher.voidedAt) return { ok: false, reason: "voided" };
  if (voucher.expiresAt && Date.parse(voucher.expiresAt) <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  // WHICH item are we spending? Only Game Zone items can be fulfilled here, and
  // only unspent ones — a multi-item voucher keeps the rest of its value.
  // Deterministic: the FIRST unspent Game Zone item, in mint order.
  let spent: Set<number>;
  try {
    spent = await spentItemIndexes(code);
  } catch (err) {
    console.error("[native-voucher] claim read failed:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "storage" };
  }
  const gzItems = voucher.items
    .map((item, index) => ({ item, index }))
    .filter((e) => e.item.kind === "gamezone");
  if (gzItems.length === 0) {
    // A live voucher we can't fulfil on this rail (e.g. laser tag only). Say so
    // distinctly from "used" — the guest still HAS value, just not here.
    console.warn(`[native-voucher] ${code} has no Game Zone item to redeem`);
    return { ok: false, reason: "not_redeemable" };
  }
  const pick = gzItems.find((e) => !spent.has(e.index));
  if (!pick) return { ok: false, reason: "used" };
  const grant = gameZoneGrant(pick.item);
  if (!grant) return { ok: false, reason: "not_redeemable" };

  const txnId = randomUUID();
  const groupId = randomUUID();
  // Ledger package id reuses the shared `gzv-<tokens>` shape so load-card and
  // the reconcile cron resolve BOTH issuers through one code path.
  const packageId = `${VOUCHER_PACKAGE_PREFIX}${grant.bonusTokens}`;

  let claimed: Awaited<ReturnType<typeof claimVoucher>>;
  try {
    claimed = await claimVoucher({
      code,
      itemIndex: pick.index,
      issuer: "native",
      compName: voucherItemLabel(pick.item),
      packageId,
      txnId,
      locationCode: input.locationCode,
      clientKey: null, // ours — no external system involved
      kioskId: input.kioskId ?? null,
    });
  } catch (err) {
    console.error("[native-voucher] claim store unavailable:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "storage" };
  }
  if (!claimed.ok) return { ok: false, reason: "used" };

  try {
    await startCompedTxn({
      txnId,
      groupId,
      // The kind encodes the FULFILMENT, which decides whether the card gets
      // clear-on-encode. Crediting a guest's own card must never look like a
      // fresh blank or the clear would wipe their existing balance.
      kind: input.accountNumber ? "voucher_reload" : "voucher",
      locationCode: input.locationCode,
      // Web: the guest's own card, known now. Kiosk: read off the blank later.
      accountNumber: input.accountNumber ?? "",
      packageId,
      tokens: grant.tokens,
      bonusTokens: grant.bonusTokens,
      tpiTransactionId: `hpwvoucher-${txnId}`,
      voucherCode: code,
    });
  } catch (err) {
    await releaseVoucherClaim(code, txnId, "ledger row insert failed").catch(() => {});
    console.error("[native-voucher] ledger insert failed:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "storage" };
  }

  await logVoucherEvent(code, "redeem", {
    txnId,
    itemIndex: pick.index,
    source: input.source,
    accountNumber: input.accountNumber ?? null,
    locationCode: input.locationCode,
  });

  // What the guest still holds — a multi-item voucher isn't finished, and the
  // screens must be able to say so instead of implying it's used up.
  const remaining: VoucherItemState[] = voucher.items
    .map((item, index) => ({
      index,
      item,
      label: voucherItemLabel(item),
      spent: spent.has(index) || index === pick.index,
      redeemable: item.kind === "gamezone",
    }))
    .filter((i) => !i.spent);

  return { ok: true, txnId, groupId, grant, packageId, itemIndex: pick.index, voucher, remaining };
}

/**
 * Hand a claim back — ONLY when nothing was delivered (guest abandoned before
 * the card moved, dispenser faulted pre-feed, or the web credit never issued).
 */
export async function releaseNativeVoucher(input: {
  code: string;
  txnId: string;
  reason: string;
}): Promise<void> {
  const code = normalizeVoucherCode(input.code);
  await releaseVoucherClaim(code, input.txnId, input.reason);
  await markChargeFailed(input.txnId, `voucher released: ${input.reason}`);
  await logVoucherEvent(code, "release", { txnId: input.txnId, reason: input.reason });
}

/** Void an unspent voucher (misprint, wrong recipient, fraud). */
export async function voidNativeVoucher(code: string, reason: string): Promise<void> {
  const c = normalizeVoucherCode(code);
  await voidVoucher(c, reason);
  await logVoucherEvent(c, "void", { reason });
}
