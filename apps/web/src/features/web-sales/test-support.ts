/**
 * Fixture builders for the web-sales suites.
 *
 * TEST-ONLY. Nothing in `app/` or the adapters imports this, so it never reaches
 * a bundle. It lives beside the source rather than in a `__fixtures__` folder
 * because vitest's `include` here only collects files ending in `.test.ts` or
 * `.spec.ts` — a plain `.ts` is never picked up as a suite, and a folder
 * convention would just be one more thing to explain.
 *
 * Both builders take a partial override so a test states ONLY the fields it is
 * actually asserting on. A test that spells out twenty irrelevant fields hides
 * the one that matters.
 */

import type { DealPurchaseRow } from "~/features/deals/data/deal-purchases-db";
import type { SaleSourceId, WebSaleRow } from "./types";

export function makeSaleRow(patch: Partial<WebSaleRow> & { source?: SaleSourceId } = {}): WebSaleRow {
  const source: SaleSourceId = patch.source ?? "deals";
  const ref = patch.ref ?? "1";
  return {
    id: `${source}:${ref}`,
    source,
    ref,
    soldAt: "2026-08-03T12:00:00.000Z",
    buyer: {
      name: "Jacob Elliott",
      email: "jacob@headpinz.com",
      phone: "+18138473894",
      recipientName: null,
      recipientEmail: null,
      recipientPhone: null,
    },
    product: { label: "Laser Tag + Game Card Pack", sublabel: "HeadPinz Fort Myers", qty: 1 },
    money: { paidCents: 3621, subtotalCents: 3400, taxCents: 221 },
    status: { code: "sent", label: "Sent", tone: "ok", problem: null },
    refund: { kind: "none" },
    attribution: { label: "direct", utm: null },
    venue: { key: "headpinz", label: "HeadPinz Fort Myers", brand: "headpinz" },
    square: { orderId: null, paymentIds: [] },
    searchTerms: [],
    capabilities: [],
    ...patch,
    // `id` is derived, so a caller overriding source/ref gets a consistent id
    // without having to remember to override three fields in step.
    ...(patch.id ? { id: patch.id } : {}),
  };
}

export function makeDealPurchaseRow(patch: Partial<DealPurchaseRow> = {}): DealPurchaseRow {
  return {
    id: 412,
    dealSlug: "laser-tag-game-card-pack",
    locationKey: "headpinz",
    centerCode: 12,
    qty: 1,
    combine: true,
    unitPriceCents: 3400,
    subtotalCents: 3400,
    taxCents: 221,
    totalCents: 3621,
    buyerName: "Jacob Elliott",
    buyerEmail: "jacob@headpinz.com",
    buyerPhone: "+18138473894",
    smsOptIn: false,
    status: "sent",
    squareOrderId: "ORDER123",
    squarePaymentId: "PAY123",
    idempotencyKey: "0123456789abcdef",
    voucherBatchId: "batch-1",
    codes: ["HPWK8EJPXCR"],
    isGift: false,
    recipientName: null,
    recipientEmail: null,
    recipientPhone: null,
    giftMessage: null,
    giftSendAt: null,
    giftSentAt: null,
    utm: null,
    clickwrapVersion: null,
    lastError: null,
    refundedAt: null,
    refundReason: null,
    abandonEmailSentAt: null,
    // Frozen at purchase, so a limited-offer pack fulfils and refunds as sold
    // rather than as the catalog reads today.
    bonusItems: [],
    createdAt: "2026-08-03T19:18:17.000Z",
    chargedAt: "2026-08-03T19:18:19.000Z",
    mintedAt: "2026-08-03T19:18:21.000Z",
    sentAt: "2026-08-03T19:18:24.000Z",
    ...patch,
  };
}
