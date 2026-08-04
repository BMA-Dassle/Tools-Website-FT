/**
 * Adapter #1 — prepaid deal packs (`deal_purchases`).
 *
 * The projection is a PURE function of a `DealPurchaseRow`, split out from the
 * adapter's I/O so it can be tested exhaustively without a database. That split
 * is not stylistic: vitest here runs in `environment: "node"` with no jsdom, so
 * anything left inside a component or welded to a query is untestable in this
 * repo. Every status arm, every capability refusal, and the gift handling are
 * asserted against fixtures in `deals.test.ts`.
 *
 * ONE THING THIS FILE DELIBERATELY DOES NOT DO: treat `refunded_at` as a refund.
 * On `deal_purchases` that column means "the vouchers were voided" and nothing
 * else — no money has ever moved through this feature. It projects to
 * `RefundState.voided`, which is a different thing from `full`. When real
 * refunds land, they get their own columns and this mapping gets a second arm;
 * conflating them now would make the first real refund indistinguishable from a
 * void in every report built on this board.
 */

import { DEAL_LOCATION_INFO, getDeal, type DealLocationKey } from "~/features/deals";
import type { DealPurchaseRow } from "~/features/deals/data/deal-purchases-db";
import {
  searchDealPurchases,
  summarizeDealPurchases,
} from "~/features/deals/data/deal-purchases-search";
import { easternRangeToUtc } from "../service/dates";
import type {
  SaleCapability,
  SaleListQuery,
  SaleSummary,
  SaleTone,
  WebSaleAdapter,
  WebSaleRow,
} from "../types";

/* ────────────────────────────── pure projection ────────────────────────── */

interface StatusView {
  label: string;
  tone: SaleTone;
  problem: string | null;
}

/**
 * Native status → what a human reads, and whether they should act.
 *
 * `problem` is the load-bearing field: it drives the "Needs attention" card and
 * its filter, which is what ops will actually use the board for. It is a
 * sentence, not a code, and it says what happens next so nobody has to ask
 * whether a stuck row is already being retried.
 */
export function dealStatusView(row: DealPurchaseRow): StatusView {
  switch (row.status) {
    case "pending":
      // A card form somebody opened and walked away from. Noise, not work —
      // never charged, so there is nothing to chase.
      return { label: "Not charged", tone: "muted", problem: null };
    case "charge_failed":
      return {
        label: "Declined",
        tone: "danger",
        problem: row.lastError || "The card was declined and nothing was taken.",
      };
    case "charged":
      return {
        label: "Awaiting codes",
        tone: "warn",
        problem: "Paid, but the vouchers were never cut — the reconcile cron retries every 30 min.",
      };
    case "minted":
      return {
        label: "Codes not sent",
        tone: "warn",
        problem: "Vouchers exist but the email never sent — the reconcile cron retries every 30 min.",
      };
    case "scheduled":
      return { label: "Gift scheduled", tone: "pending", problem: null };
    case "sent":
      return { label: "Sent", tone: "ok", problem: null };
    default:
      // A status this build has never heard of is worth surfacing, not hiding:
      // it means the writer shipped ahead of the reader.
      return { label: row.status, tone: "warn", problem: `Unrecognised status "${row.status}".` };
  }
}

/** Ad attribution, in the words the board shows. */
export function dealAttributionLabel(utm: Record<string, string> | null): string {
  if (!utm) return "direct";
  const named = [utm.utm_source, utm.utm_campaign].filter(Boolean).join(" / ");
  if (named) return named;
  return utm.gclid ? "google ads" : "unknown";
}

const PAID_FOR_ACTIONS = new Set(["charged", "minted", "scheduled", "sent"]);

/**
 * What staff may do to this row, and — when they may not — why.
 *
 * Every refusal is expressed as a PRESENT capability with a `blockedReason`, not
 * as an absent one. A button that vanishes is a support ticket; a disabled button
 * that says "never charged — nothing to send" is an answer.
 */
export function dealCapabilities(row: DealPurchaseRow): SaleCapability[] {
  const paid = PAID_FOR_ACTIONS.has(row.status);
  const voided = row.refundedAt !== null;

  const resend: SaleCapability = { action: "resend", label: "Resend" };
  if (!paid) resend.blockedReason = "That purchase was never charged — nothing to send.";
  else if (row.codes.length === 0) resend.blockedReason = "No codes minted yet — try again shortly.";

  const refund: SaleCapability = { action: "refund", label: "Refund" };
  if (!paid) refund.blockedReason = "Never charged — there is nothing to refund.";
  else if (voided) refund.blockedReason = "Already voided on this purchase.";
  else if (!row.squarePaymentId)
    refund.blockedReason = "No Square payment recorded — refund this one by hand.";

  const voidCap: SaleCapability = { action: "void", label: "Void" };
  if (!paid) voidCap.blockedReason = "Never charged — there are no live vouchers.";
  else if (voided) voidCap.blockedReason = "Already voided.";
  else if (row.codes.length === 0) voidCap.blockedReason = "No codes minted yet.";

  return [resend, refund, voidCap];
}

/** `Laser Tag + Game Card Pack` sold to somebody else, at a named venue. */
function dealSublabel(row: DealPurchaseRow): string {
  const venue = DEAL_LOCATION_INFO[row.locationKey as DealLocationKey]?.label ?? row.locationKey;
  const parts = [venue];
  if (row.qty > 1) parts.push(row.combine ? `${row.qty} packs combined` : `${row.qty} separate codes`);
  if (row.isGift) parts.push(`gift for ${row.recipientName ?? "a recipient"}`);
  return parts.join(" · ");
}

export function projectDealRow(row: DealPurchaseRow): WebSaleRow {
  const deal = getDeal(row.dealSlug);
  const info = DEAL_LOCATION_INFO[row.locationKey as DealLocationKey];
  const status = dealStatusView(row);

  return {
    id: `deals:${row.id}`,
    source: "deals",
    ref: String(row.id),
    // `created_at`, matching the adapter's ORDER BY and keyset key exactly — see
    // the note on WebSaleRow.soldAt about why this must not be `charged_at`.
    soldAt: row.createdAt,
    buyer: {
      name: row.buyerName,
      email: row.buyerEmail,
      phone: row.buyerPhone,
      recipientName: row.isGift ? row.recipientName : null,
      recipientEmail: row.isGift ? row.recipientEmail : null,
      recipientPhone: row.isGift ? row.recipientPhone : null,
    },
    product: {
      label: deal?.name ?? row.dealSlug,
      sublabel: dealSublabel(row),
      qty: row.qty,
    },
    money: {
      paidCents: row.totalCents,
      subtotalCents: row.subtotalCents,
      taxCents: row.taxCents,
    },
    status: { code: row.status, ...status },
    refund: row.refundedAt
      ? { kind: "voided", at: row.refundedAt, reason: row.refundReason }
      : { kind: "none" },
    attribution: { label: dealAttributionLabel(row.utm), utm: row.utm },
    venue: {
      key: row.locationKey,
      label: info?.label ?? row.locationKey,
      // Deals are HeadPinz-only — FastTrax sells neither laser tag nor gel blasters.
      brand: "headpinz",
    },
    square: {
      orderId: row.squareOrderId,
      paymentIds: row.squarePaymentId ? [row.squarePaymentId] : [],
    },
    searchTerms: [...row.codes, row.voucherBatchId, row.idempotencyKey].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    ),
    capabilities: dealCapabilities(row),
  };
}

/* ──────────────────────────────── the adapter ──────────────────────────── */

const STATUS_FILTERS = [
  { value: "sent", label: "Sent" },
  { value: "scheduled", label: "Gift scheduled" },
  { value: "minted", label: "Codes not sent" },
  { value: "charged", label: "Awaiting codes" },
  { value: "charge_failed", label: "Declined" },
  { value: "pending", label: "Not charged" },
] as const;

export const dealsAdapter: WebSaleAdapter = {
  id: "deals",
  label: "Deal packs",
  sublabel: "Prepaid voucher bundles sold on headpinz.com/deals",
  statusFilters: STATUS_FILTERS,
  venues: [
    { key: "headpinz", label: DEAL_LOCATION_INFO.headpinz.label, brand: "headpinz" },
    { key: "naples", label: DEAL_LOCATION_INFO.naples.label, brand: "headpinz" },
  ],
  /**
   * Empty on purpose while this adapter is read-only.
   *
   * Capabilities are computed per row above and are fully tested, but the shell
   * only renders an action listed HERE — so a board built on this PR shows no
   * action buttons at all, which is exactly what a read-only board should do.
   * Each action joins this list in the PR that implements its handler.
   */
  actions: [],
  resendChannels: ["email", "sms", "both"],

  async list(q: SaleListQuery): Promise<WebSaleRow[]> {
    const { startUtc, endUtc } = easternRangeToUtc(q.from, q.to);
    const rows = await searchDealPurchases({
      startUtc,
      endUtc,
      status: q.status,
      venue: q.venue,
      q: q.q,
      before: q.before,
      limit: q.limit,
    });
    return rows.map(projectDealRow);
  },

  async summarize(q: Omit<SaleListQuery, "before" | "limit">): Promise<SaleSummary> {
    const { startUtc, endUtc } = easternRangeToUtc(q.from, q.to);
    const totals = await summarizeDealPurchases({
      startUtc,
      endUtc,
      status: q.status,
      venue: q.venue,
      q: q.q,
    });

    return {
      grossCents: totals.grossCents,
      // No money has moved through this feature yet — `refunded_at` is a void.
      // Reporting it as refunded dollars would invent a number.
      refundedCents: 0,
      saleCount: totals.saleCount,
      unitCount: totals.packsSold,
      problemCount: totals.problemCount,
      // Per-deal cards, shown only when deals is the sole selected source. This
      // is the rollup the single-product board had, carried across intact.
      extra: totals.byDeal.map((d) => ({
        label: getDeal(d.dealSlug)?.name ?? d.dealSlug,
        value: String(d.packsSold),
        sublabel:
          `packs · $${(d.grossCents / 100).toFixed(2)} gross` +
          (d.unfulfilled > 0 ? ` · ${d.unfulfilled} awaiting codes or email` : ""),
        tone: d.unfulfilled > 0 ? "warn" : "ok",
      })),
    };
  },

  async detail(): Promise<null> {
    // Lands with the drawer PR, together with legs, timeline and facts. Returning
    // null here is honest: the board has nothing extra to show yet.
    return null;
  },
};
