/**
 * Buy a deal pack: charge once, mint the voucher(s), email the codes.
 *
 * By DEFAULT several packs COMBINE onto one code (owner 2026-08-03: "default
 * combine"). Legs are claimed per `(code, itemIndex)`, so combining costs the
 * buyer nothing — a combined voucher is still redeemable across multiple visits
 * and by multiple people. Separate codes matter only when packs are going to
 * DIFFERENT people, which is the one thing splitting buys.
 *
 * DOCTRINE — persist-first, recover-forward. In order:
 *
 *   1. re-derive price + items from the slug        (never trust the client)
 *   2. enforce the per-buyer cap against history
 *   3. price the real Square order, and REFUSE if the total moved
 *   4. write the purchase row  ← before any money moves
 *   5. charge
 *   6. mint  ← soft-fail past this point
 *   7. email ← soft-fail
 *
 * Step 4 before step 5 is a hard repo rule: everything a guest hands us is in
 * our own DB at the moment of capture, independent of the external call, so a
 * Square failure never loses recoverable data. Steps 6 and 7 are soft because
 * the money is already taken — throwing there would show the buyer an error for
 * a purchase that succeeded, and the reconcile cron finishes the job instead.
 *
 * NOTHING IS SCHEDULED HERE. A pack is always just a voucher (owner 2026-08-02:
 * "could it just be vouchers always? That way if they don't end up booking it's
 * still available to them"). Picking a time is an optional hop afterwards into
 * the normal booking wizard with the code pre-applied, so an abandoned booking
 * costs the buyer nothing.
 */

import { randomBytes } from "crypto";
import { authorizeMultiTender, SquarePaymentError } from "@/lib/square-gift-card";
import { mintVouchers } from "~/features/game-cards/service/native-voucher";
import {
  emailPurchasedVouchers,
  notifyStaffDealSale,
  smsPurchasedVouchers,
} from "~/features/game-cards/service/voucher-mail";
import { voidNativeVoucher } from "~/features/game-cards/service/native-voucher";
import {
  DEAL_LOCATION_INFO,
  dealExpiryFrom,
  dealVoucherItems,
  dealVoucherSummary,
  getDeal,
  type DealCatalogEntry,
  type DealLocationKey,
} from "../catalog";
import {
  getDealPurchase,
  insertDealPurchase,
  markDealPurchaseCharged,
  markDealPurchaseChargeFailed,
  markDealPurchaseMinted,
  markDealPurchaseSent,
  recordDealPurchaseError,
  type DealPurchaseRow,
} from "../data/deal-purchases-db";
import { checkBuyerCap } from "./cap";
import { assertQuoteMatches, createDealOrder, DEAL_SQUARE_LOCATION, DealQuoteError } from "./quote";
import type { DealPurchaseInput } from "../schemas";

/** Typed failure the route maps to a status code + guest-facing message. */
export class DealPurchaseError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Card-decline copy, matching the table the game-card purchase path uses. Square
 * codes are not guest-readable and "GENERIC_DECLINE" in a checkout is how you
 * get a support call.
 */
const FRIENDLY_DECLINE: Record<string, string> = {
  INSUFFICIENT_FUNDS: "Card declined — insufficient funds. Try a different card.",
  GENERIC_DECLINE: "Card declined. Please try a different card.",
  CVV_FAILURE: "CVV check failed. Please re-enter your card details.",
  CARD_EXPIRED: "Card expired. Please use a different card.",
  CARD_DECLINED: "Card declined. Please try a different card.",
  CARD_DECLINED_VERIFICATION_REQUIRED: "Additional verification required. Please try again.",
  ADDRESS_VERIFICATION_FAILURE: "Billing ZIP didn't match. Please re-enter your card details.",
};

function friendlyDecline(err: SquarePaymentError): string {
  return FRIENDLY_DECLINE[err.code] ?? "We couldn't process that card. Please try another.";
}

export interface DealPurchaseResult {
  purchaseId: number;
  dealSlug: string;
  dealName: string;
  location: DealLocationKey;
  qty: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** The minted voucher codes, unhyphenated. Empty only if the mint is pending. */
  codes: string[];
  expiresAt: string | null;
  /** True when the charge landed but the vouchers aren't cut yet (cron will). */
  mintPending: boolean;
  /** True when the codes exist but the email didn't send (cron will retry). */
  emailPending: boolean;
  /** Deep link into the booking wizard with the first code pre-applied. */
  scheduleUrl: string | null;
}

/** Where to send a buyer who wants to book the timed half of their pack now. */
export function dealScheduleUrl(args: {
  deal: DealCatalogEntry;
  location: DealLocationKey;
  codes: string[];
}): string | null {
  if (args.codes.length === 0) return null;
  const params = new URLSearchParams({
    location: args.location === "naples" ? "naples" : "fort-myers",
    // Every code is seeded: a buyer with 3 packs booking together should get all
    // 6 admissions covered, and the wizard's own group-size cap is what limits it.
    voucher: args.codes.join(","),
  });
  return `/book/${args.deal.scheduleSlug}/v2?${params.toString()}`;
}

/**
 * Mint + email for an already-charged purchase. Split out because BOTH the live
 * request and the reconcile cron run it, and it must be safe to run twice.
 *
 * The mint is fenced by a conditional UPDATE on `voucher_batch_id IS NULL`. If
 * that returns false another writer got there first, and we VOID what we just
 * minted rather than leaving orphan vouchers loose in the wild — the codes are
 * bearer instruments, so an unreferenced live one is real money.
 */
export async function fulfilDealPurchase(row: DealPurchaseRow): Promise<{
  codes: string[];
  mintPending: boolean;
  emailPending: boolean;
}> {
  const deal = getDeal(row.dealSlug);
  if (!deal) {
    await recordDealPurchaseError(row.id, `unknown deal slug ${row.dealSlug}`);
    return { codes: row.codes, mintPending: row.codes.length === 0, emailPending: true };
  }

  let codes = row.codes;
  const expiresAt = dealExpiryFrom(new Date(row.createdAt), deal.expiresMonths);

  if (!row.voucherBatchId) {
    let minted: { batchId: string; codes: string[] } | null = null;
    try {
      // COMBINED (default) = ONE code carrying every pack; SPLIT = one per pack.
      // Read off the ROW, never the request, so a cron re-run mints the same shape
      // the buyer was promised.
      //
      // Combining does not reduce what they can do with it: legs are claimed
      // independently per (code, itemIndex), so a combined voucher is redeemable
      // across as many visits and as many people as separate codes would be. The
      // only thing separate codes buy is the ability to hand ONE pack to someone
      // else, which is exactly what the split option is for.
      const res = await mintVouchers({
        count: row.combine ? 1 : row.qty,
        items: dealVoucherItems(deal, row.combine ? row.qty : 1),
        expiresAt,
        issuedSource: `deal:${deal.slug}`,
        issuedTo: {
          email: row.buyerEmail,
          ...(row.buyerPhone ? { phone: row.buyerPhone } : {}),
          ...(row.buyerName ? { name: row.buyerName } : {}),
        },
        batchLabel: `${deal.name} — purchase #${row.id}${
          row.combine && row.qty > 1 ? ` (${row.qty} packs combined)` : ""
        }`,
      });
      minted = { batchId: res.batchId, codes: res.vouchers.map((v) => v.code) };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[deals] mint failed for purchase ${row.id} (cron will recover):`, detail);
      await recordDealPurchaseError(row.id, `mint failed: ${detail}`);
      return { codes: [], mintPending: true, emailPending: true };
    }

    const won = await markDealPurchaseMinted(row.id, minted);
    if (!won) {
      // Another writer already fulfilled this purchase. Ours are surplus bearer
      // instruments — void them, then continue with the ones that count.
      console.warn(
        `[deals] purchase ${row.id} already minted elsewhere — voiding ${minted.codes.length} surplus code(s)`,
      );
      for (const code of minted.codes) {
        await voidNativeVoucher(code, `duplicate mint for deal purchase ${row.id}`).catch(
          (err: unknown) => console.error(`[deals] could not void surplus voucher ${code}:`, err),
        );
      }
      const fresh = await getDealPurchase(row.id);
      codes = fresh?.codes ?? [];
      if (fresh?.status === "sent") return { codes, mintPending: false, emailPending: false };
    } else {
      codes = minted.codes;
    }
  }

  if (codes.length === 0) return { codes, mintPending: true, emailPending: true };

  const mail = await emailPurchasedVouchers({
    to: row.buyerEmail,
    name: row.buyerName,
    productName: deal.name,
    codes,
    items: dealVoucherItems(deal, row.combine ? row.qty : 1),
    valueSummary: dealVoucherSummary(deal, row.combine ? row.qty : 1),
    expiresAt,
    scheduleUrl: absoluteUrl(dealScheduleUrl({ deal, location: row.locationKey, codes })),
    scheduleLabel: `Pick your ${deal.scheduleSlug === "gel-blaster" ? "gel blaster" : "laser tag"} time`,
  }).catch((err: unknown) => ({
    ok: false as const,
    error: err instanceof Error ? err.message : String(err),
  }));

  if (!mail.ok) {
    console.error(`[deals] purchase ${row.id} email failed (cron will retry):`, mail.error);
    await recordDealPurchaseError(row.id, `email failed: ${mail.error ?? "unknown"}`);
    return { codes, mintPending: false, emailPending: true };
  }

  // Opt-in text. The buy panel says "Text me my voucher code too", so not sending
  // one is a broken promise — but it must not gate `sent`: the email carried the
  // codes, and re-running fulfilment to retry a text would re-send that email.
  // A failure is logged and left alone.
  if (row.smsOptIn && row.buyerPhone) {
    const sms = await smsPurchasedVouchers({
      phone: row.buyerPhone,
      productName: deal.name,
      codes,
    }).catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    }));
    if (!sms.ok) {
      console.error(`[deals] purchase ${row.id} SMS failed (email did land):`, sms.error);
      await recordDealPurchaseError(row.id, `sms failed: ${sms.error ?? "unknown"}`);
    }
  }

  // Staff heads-up (owner 2026-08-03: "when these sell can you email jacob and i
  // for now"). Fired AFTER the buyer's mail and fully detached from it: a
  // staff-notify failure must never mark the guest's delivery unsent or trigger a
  // resend of their codes. Guarded so a cron re-run of an already-`sent` purchase
  // doesn't email staff a second time about the same sale.
  if (row.status !== "sent") {
    const deal2 = getDeal(row.dealSlug);
    void notifyStaffDealSale({
      dealName: deal2?.name ?? row.dealSlug,
      qty: row.qty,
      combined: row.combine,
      locationLabel: DEAL_LOCATION_INFO[row.locationKey]?.label ?? row.locationKey,
      totalCents: row.totalCents,
      buyerName: row.buyerName,
      buyerEmail: row.buyerEmail,
      codes,
      purchaseId: row.id,
      utm: row.utm,
    }).catch((err: unknown) => console.error("[deals] staff notify failed (non-fatal):", err));
  }

  await markDealPurchaseSent(row.id);
  return { codes, mintPending: false, emailPending: false };
}

function siteOrigin(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || "https://headpinz.com").replace(/\/$/, "");
}

function absoluteUrl(path: string | null): string | null {
  return path ? `${siteOrigin()}${path}` : null;
}

/**
 * The whole purchase. Throws `DealPurchaseError` for anything the buyer can act
 * on; everything past the capture is soft-failed onto the reconcile cron.
 */
export async function purchaseDeal(input: DealPurchaseInput): Promise<DealPurchaseResult> {
  const deal = getDeal(input.slug);
  if (!deal) throw new DealPurchaseError("UNKNOWN_DEAL", "That deal isn't available.", 404);

  const location = input.location as DealLocationKey;
  if (!deal.locations.includes(location)) {
    throw new DealPurchaseError("WRONG_LOCATION", `${deal.name} isn't available at that location.`);
  }

  // ── 2. cap ─────────────────────────────────────────────────────────────
  const cap = await checkBuyerCap({
    deal,
    requested: input.qty,
    email: input.buyer.email,
    phone: input.buyer.phone,
  });
  if (!cap.ok) {
    throw new DealPurchaseError("CAP_REACHED", cap.message ?? "Purchase limit reached.", 409);
  }

  // ── 3. price the real order, refuse if it moved ─────────────────────────
  // 16 hex leaves room for Square's longest prefix inside the 45-char
  // idempotency-key limit (`deal-order-` = 11, so 11 + 16 = 27).
  const baseKey = randomBytes(8).toString("hex");
  let orderId: string;
  let quote: Awaited<ReturnType<typeof createDealOrder>>["quote"];
  try {
    const created = await createDealOrder({ deal, location, qty: input.qty, baseKey });
    orderId = created.orderId;
    quote = created.quote;
    assertQuoteMatches(input.shownTotalCents, quote);
  } catch (err) {
    if (err instanceof DealQuoteError) {
      const status = err.code === "PRICE_CHANGED" ? 409 : 503;
      throw new DealPurchaseError(err.code, err.message, status);
    }
    throw err;
  }

  // ── 4. persist BEFORE money moves ──────────────────────────────────────
  const info = DEAL_LOCATION_INFO[location];
  const row = await insertDealPurchase({
    dealSlug: deal.slug,
    locationKey: location,
    centerCode: info.centerCode,
    qty: input.qty,
    combine: input.combine,
    unitPriceCents: deal.priceCents,
    subtotalCents: quote.subtotalCents,
    taxCents: quote.taxCents,
    totalCents: quote.totalCents,
    buyerName: input.buyer.name,
    buyerEmail: input.buyer.email,
    buyerPhone: input.buyer.phone,
    smsOptIn: input.buyer.smsOptIn,
    idempotencyKey: baseKey,
    utm: input.utm && Object.keys(input.utm).length > 0 ? input.utm : null,
    clickwrapVersion: input.clickwrapVersion ?? null,
  });

  // ── 5. charge ──────────────────────────────────────────────────────────
  let paymentId: string | null = null;
  try {
    const tender = await authorizeMultiTender({
      orderId,
      locationId: DEAL_SQUARE_LOCATION[location],
      totalCents: quote.totalCents,
      baseKey,
      cardSourceId: input.cardNonce,
      buyerEmail: input.buyer.email,
      note: `${deal.name} ×${input.qty} — ${info.label}`,
    });
    paymentId = tender.cardPaymentId ?? tender.gcPaymentId ?? null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await markDealPurchaseChargeFailed(row.id, detail);
    if (err instanceof SquarePaymentError) {
      throw new DealPurchaseError(err.code, friendlyDecline(err), 402);
    }
    throw new DealPurchaseError("CHARGE_FAILED", "We couldn't process that payment.", 502);
  }

  await markDealPurchaseCharged(row.id, { squareOrderId: orderId, squarePaymentId: paymentId });

  // ── 6/7. mint + email — soft-fail, the money is already taken ──────────
  const charged: DealPurchaseRow = {
    ...row,
    status: "charged",
    squareOrderId: orderId,
    squarePaymentId: paymentId,
    chargedAt: new Date().toISOString(),
  };
  const fulfilled = await fulfilDealPurchase(charged).catch((err: unknown) => {
    console.error(`[deals] fulfilment threw for purchase ${row.id} (cron will recover):`, err);
    return { codes: [] as string[], mintPending: true, emailPending: true };
  });

  return {
    purchaseId: row.id,
    dealSlug: deal.slug,
    dealName: deal.name,
    location,
    qty: input.qty,
    subtotalCents: quote.subtotalCents,
    taxCents: quote.taxCents,
    totalCents: quote.totalCents,
    codes: fulfilled.codes,
    expiresAt: dealExpiryFrom(new Date(charged.createdAt), deal.expiresMonths),
    mintPending: fulfilled.mintPending,
    emailPending: fulfilled.emailPending,
    scheduleUrl: dealScheduleUrl({ deal, location, codes: fulfilled.codes }),
  };
}
