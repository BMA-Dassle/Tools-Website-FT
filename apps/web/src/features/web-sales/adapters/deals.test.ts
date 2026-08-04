import { describe, expect, it } from "vitest";
import { dealAttributionLabel, dealCapabilities, dealStatusView, projectDealRow } from "./deals";
import { makeDealPurchaseRow } from "../test-support";
import type { SaleAction, SaleCapability } from "../types";

const blockedReason = (caps: SaleCapability[], action: SaleAction): string | undefined =>
  caps.find((c) => c.action === action)?.blockedReason;

describe("dealStatusView", () => {
  it("maps every native status to a label and a tone", () => {
    const seen = (["pending", "charged", "minted", "scheduled", "sent", "charge_failed"] as const).map(
      (status) => {
        const v = dealStatusView(makeDealPurchaseRow({ status }));
        return [status, v.label, v.tone];
      },
    );
    expect(seen).toEqual([
      ["pending", "Not charged", "muted"],
      ["charged", "Awaiting codes", "warn"],
      ["minted", "Codes not sent", "warn"],
      ["scheduled", "Gift scheduled", "pending"],
      ["sent", "Sent", "ok"],
      ["charge_failed", "Declined", "danger"],
    ]);
  });

  it("styles a scheduled gift instead of leaving it unstyled", () => {
    // The single-product board has no `scheduled` arm, so a scheduled gift falls
    // through to plain grey. This is the regression that fixes.
    const v = dealStatusView(makeDealPurchaseRow({ status: "scheduled", isGift: true }));
    expect(v.tone).toBe("pending");
    expect(v.label).toBe("Gift scheduled");
    expect(v.problem).toBeNull();
  });

  it("flags only the statuses a human should act on", () => {
    const problem = (status: Parameters<typeof makeDealPurchaseRow>[0] extends never ? never : string) =>
      dealStatusView(makeDealPurchaseRow({ status: status as never })).problem;
    expect(problem("sent")).toBeNull();
    expect(problem("scheduled")).toBeNull();
    // An abandoned card form is noise — nothing was ever charged.
    expect(problem("pending")).toBeNull();
    expect(problem("charged")).toContain("reconcile cron");
    expect(problem("minted")).toContain("reconcile cron");
  });

  it("surfaces the decline reason verbatim when there is one", () => {
    const v = dealStatusView(
      makeDealPurchaseRow({ status: "charge_failed", lastError: "Authorization error: 'TRANSACTION_LIMIT'" }),
    );
    expect(v.problem).toBe("Authorization error: 'TRANSACTION_LIMIT'");
  });

  it("falls back to a readable message when the decline reason is missing", () => {
    const v = dealStatusView(makeDealPurchaseRow({ status: "charge_failed", lastError: null }));
    expect(v.problem).toBe("The card was declined and nothing was taken.");
  });

  it("surfaces an unrecognised status rather than hiding it", () => {
    const v = dealStatusView(makeDealPurchaseRow({ status: "teleported" as never }));
    expect(v.tone).toBe("warn");
    expect(v.problem).toContain("Unrecognised status");
  });
});

describe("dealAttributionLabel", () => {
  it("calls an absent UTM blob direct", () => {
    expect(dealAttributionLabel(null)).toBe("direct");
  });

  it("prefers source / campaign", () => {
    expect(dealAttributionLabel({ utm_source: "google", utm_campaign: "aug-deals" })).toBe(
      "google / aug-deals",
    );
    expect(dealAttributionLabel({ utm_source: "facebook" })).toBe("facebook");
  });

  it("recognises a bare gclid as google ads", () => {
    expect(dealAttributionLabel({ gclid: "abc123" })).toBe("google ads");
  });

  it("says unknown for a UTM blob that names nothing", () => {
    // Distinct from "direct": we DID get tracking params, they just said nothing.
    expect(dealAttributionLabel({ utm_medium: "cpc" })).toBe("unknown");
  });
});

describe("dealCapabilities", () => {
  it("allows everything on a healthy paid sale", () => {
    const caps = dealCapabilities(makeDealPurchaseRow());
    expect(caps.map((c) => c.action)).toEqual(["resend", "refund", "void"]);
    expect(caps.every((c) => c.blockedReason === undefined)).toBe(true);
  });

  it("blocks every action on a decline, and says why", () => {
    const caps = dealCapabilities(makeDealPurchaseRow({ status: "charge_failed" }));
    // Present-but-disabled, never absent — a vanished button is a support ticket.
    expect(caps.map((c) => c.action)).toEqual(["resend", "refund", "void"]);
    expect(blockedReason(caps, "resend")).toBe("That purchase was never charged — nothing to send.");
    expect(blockedReason(caps, "refund")).toBe("Never charged — there is nothing to refund.");
    expect(blockedReason(caps, "void")).toBe("Never charged — there are no live vouchers.");
  });

  it("blocks refund and void once the vouchers are voided, but still allows a resend", () => {
    const caps = dealCapabilities(
      makeDealPurchaseRow({ refundedAt: "2026-08-03T20:00:00.000Z", refundReason: "duplicate" }),
    );
    expect(blockedReason(caps, "refund")).toBe("Already voided on this purchase.");
    expect(blockedReason(caps, "void")).toBe("Already voided.");
    // Staff still need to be able to re-send a receipt for a voided sale.
    expect(blockedReason(caps, "resend")).toBeUndefined();
  });

  it("blocks a refund with no Square payment on file", () => {
    const caps = dealCapabilities(makeDealPurchaseRow({ squarePaymentId: null }));
    expect(blockedReason(caps, "refund")).toBe("No Square payment recorded — refund this one by hand.");
  });

  it("blocks resend and void while the codes have not been minted", () => {
    const caps = dealCapabilities(makeDealPurchaseRow({ status: "charged", codes: [] }));
    expect(blockedReason(caps, "resend")).toBe("No codes minted yet — try again shortly.");
    expect(blockedReason(caps, "void")).toBe("No codes minted yet.");
    // A charged row with no codes is still refundable — that is money we hold.
    expect(blockedReason(caps, "refund")).toBeUndefined();
  });
});

describe("projectDealRow", () => {
  it("builds a stable id and an opaque ref", () => {
    const row = projectDealRow(makeDealPurchaseRow({ id: 412 }));
    expect(row.id).toBe("deals:412");
    expect(row.ref).toBe("412");
    expect(row.source).toBe("deals");
  });

  it("sorts on created_at, matching the adapter's keyset key rather than charged_at", () => {
    // If these ever diverge, keyset paging skips or repeats sales.
    const row = projectDealRow(
      makeDealPurchaseRow({
        createdAt: "2026-08-03T19:18:17.000Z",
        chargedAt: "2026-08-03T19:18:19.000Z",
      }),
    );
    expect(row.soldAt).toBe("2026-08-03T19:18:17.000Z");
  });

  it("names the product from the live catalog", () => {
    const row = projectDealRow(makeDealPurchaseRow({ dealSlug: "gel-blaster-game-card-pack" }));
    expect(row.product.label).toBe("Gel Blaster + Game Card Pack");
    expect(row.venue.label).toBe("HeadPinz Fort Myers");
    expect(row.venue.brand).toBe("headpinz");
  });

  it("falls back to the slug for a deal that has left the catalog", () => {
    // Retiring a deal must not blank out its historical sales.
    const row = projectDealRow(makeDealPurchaseRow({ dealSlug: "retired-2024-pack" }));
    expect(row.product.label).toBe("retired-2024-pack");
  });

  it("spells out how multiple packs were minted", () => {
    expect(projectDealRow(makeDealPurchaseRow({ qty: 3, combine: true })).product.sublabel).toBe(
      "HeadPinz Fort Myers · 3 packs combined",
    );
    expect(projectDealRow(makeDealPurchaseRow({ qty: 3, combine: false })).product.sublabel).toBe(
      "HeadPinz Fort Myers · 3 separate codes",
    );
    expect(projectDealRow(makeDealPurchaseRow({ qty: 1 })).product.sublabel).toBe("HeadPinz Fort Myers");
  });

  it("exposes the recipient on a gift and marks it in the sublabel", () => {
    const row = projectDealRow(
      makeDealPurchaseRow({
        isGift: true,
        recipientName: "Dana",
        recipientEmail: "dana@example.com",
        recipientPhone: "+12395551234",
        status: "scheduled",
      }),
    );
    expect(row.buyer.recipientName).toBe("Dana");
    expect(row.buyer.recipientEmail).toBe("dana@example.com");
    expect(row.buyer.recipientPhone).toBe("+12395551234");
    expect(row.product.sublabel).toContain("gift for Dana");
    // The buyer is still the buyer — a gift adds a party, it does not replace one.
    expect(row.buyer.email).toBe("jacob@headpinz.com");
  });

  it("does not leak recipient fields onto a non-gift", () => {
    // The columns can hold stale values from an edited purchase; `is_gift` rules.
    const row = projectDealRow(makeDealPurchaseRow({ isGift: false, recipientName: "Leftover" }));
    expect(row.buyer.recipientName).toBeNull();
  });

  it("reports a voided purchase as voided, never as refunded", () => {
    // `refunded_at` on this table means the vouchers were killed and the money
    // was deliberately left alone. Calling it a refund would make the first real
    // refund indistinguishable from a void.
    const row = projectDealRow(
      makeDealPurchaseRow({ refundedAt: "2026-08-03T20:00:00.000Z", refundReason: "bought twice" }),
    );
    expect(row.refund).toEqual({
      kind: "voided",
      at: "2026-08-03T20:00:00.000Z",
      reason: "bought twice",
    });
  });

  it("carries the money through tax-inclusive", () => {
    const row = projectDealRow(makeDealPurchaseRow());
    expect(row.money).toEqual({ paidCents: 3621, subtotalCents: 3400, taxCents: 221 });
  });

  it("indexes codes, batch and idempotency key for search, dropping the empties", () => {
    const row = projectDealRow(
      makeDealPurchaseRow({ codes: ["HPWK8EJPXCR"], voucherBatchId: null, idempotencyKey: "0123456789abcdef" }),
    );
    expect(row.searchTerms).toEqual(["HPWK8EJPXCR", "0123456789abcdef"]);
  });

  it("lists the Square payment id only when there is one", () => {
    expect(projectDealRow(makeDealPurchaseRow()).square.paymentIds).toEqual(["PAY123"]);
    expect(projectDealRow(makeDealPurchaseRow({ squarePaymentId: null })).square.paymentIds).toEqual([]);
  });
});
