/**
 * processSquareBowlingRefund — the legacy full-cancel refund path.
 *
 * Focus: the tender-verification gate. This helper treats the internal gift
 * card's live BALANCE as the amount to refund, which is only safe while that
 * balance still represents un-spent deposit money. A post-day-of item refund
 * credits the card asynchronously, so the balance goes non-zero again — and an
 * unverified refund of "the whole balance" against the deposit payment would
 * return money the item refund already returned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/features/discount-codes", () => ({ refundRedemption: vi.fn(async () => {}) }));

import { processSquareBowlingRefund } from "./square-bowling-refund";

const json = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as unknown as Response;

/** Route each Square call by URL+method to a queued response. */
function mockSquare(handlers: {
  giftCard?: () => Response | Promise<Response>;
  order?: () => Response | Promise<Response>;
  refund?: () => Response | Promise<Response>;
  fallback?: () => Response | Promise<Response>;
}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.includes("/gift-cards/") && method === "GET") {
        return handlers.giftCard?.() ?? json({ gift_card: { balance_money: { amount: 5000 } } });
      }
      if (url.includes("/orders/") && method === "GET") {
        return handlers.order?.() ?? json({ order: { tenders: [] } });
      }
      if (url.endsWith("/refunds") && method === "POST") {
        return (
          handlers.refund?.() ?? json({ refund: { id: "RF1", amount_money: { amount: 5000 } } })
        );
      }
      return handlers.fallback?.() ?? json({});
    }),
  );
  return calls;
}

const base = {
  depositPaymentId: "PAY_DEP",
  giftCardId: "GC1",
  locationId: "TXBSQN0FEKQ11",
  idempotencyKey: "qamf-cancel-wh1",
};

beforeEach(() => {
  process.env.SQUARE_ACCESS_TOKEN = "test-token";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("processSquareBowlingRefund — tender verification gate", () => {
  it("refunds per tender when the deposit order's tenders sum to the gift card balance", async () => {
    const calls = mockSquare({
      giftCard: () => json({ gift_card: { balance_money: { amount: 5000 } } }),
      order: () =>
        json({
          order: {
            tenders: [
              { payment_id: "PAY_GC", amount_money: { amount: 3000 } },
              { payment_id: "PAY_CARD", amount_money: { amount: 2000 } },
            ],
          },
        }),
      refund: () => json({ refund: { id: "RF_T", amount_money: { amount: 3000 } } }),
    });

    const res = await processSquareBowlingRefund({ ...base, depositOrderId: "DEP1" });

    const refundCalls = calls.filter((c) => c.url.endsWith("/refunds"));
    expect(refundCalls).toHaveLength(2);
    expect(refundCalls.map((c) => (c.body as { payment_id: string }).payment_id)).toEqual([
      "PAY_GC",
      "PAY_CARD",
    ]);
    expect(res.refundIds).toHaveLength(2);
  });

  it("REFUSES when a deposit order was named but its tenders could not be read", async () => {
    // The double-refund path: a transient order-fetch failure used to fall
    // back to refunding the whole gift-card balance against the deposit
    // payment, unchecked. After a post-day-of item refund credits that card,
    // the balance is money already returned to the guest.
    const calls = mockSquare({
      giftCard: () => json({ gift_card: { balance_money: { amount: 1605 } } }),
      order: () => {
        throw new Error("ECONNRESET");
      },
    });

    await expect(processSquareBowlingRefund({ ...base, depositOrderId: "DEP1" })).rejects.toThrow(
      /tenders could not be verified/i,
    );

    // Fails BEFORE any money moves.
    expect(calls.filter((c) => c.url.endsWith("/refunds"))).toHaveLength(0);
  });

  it("REFUSES when the deposit order responds non-OK (tenders unverifiable)", async () => {
    const calls = mockSquare({
      giftCard: () => json({ gift_card: { balance_money: { amount: 1605 } } }),
      order: () => json({ errors: [{ detail: "nope" }] }, false, 500),
    });

    await expect(processSquareBowlingRefund({ ...base, depositOrderId: "DEP1" })).rejects.toThrow(
      /tenders could not be verified/i,
    );
    expect(calls.filter((c) => c.url.endsWith("/refunds"))).toHaveLength(0);
  });

  it("still refuses a partial-redemption mismatch (tender sum != balance)", async () => {
    const calls = mockSquare({
      giftCard: () => json({ gift_card: { balance_money: { amount: 1605 } } }),
      order: () =>
        json({ order: { tenders: [{ payment_id: "PAY_DEP", amount_money: { amount: 5000 } }] } }),
    });

    await expect(processSquareBowlingRefund({ ...base, depositOrderId: "DEP1" })).rejects.toThrow(
      /Refund mismatch/,
    );
    expect(calls.filter((c) => c.url.endsWith("/refunds"))).toHaveLength(0);
  });

  it("legacy single-payment path (no deposit order id) is unaffected", async () => {
    const calls = mockSquare({
      giftCard: () => json({ gift_card: { balance_money: { amount: 5000 } } }),
      refund: () => json({ refund: { id: "RF_LEGACY", amount_money: { amount: 5000 } } }),
    });

    const res = await processSquareBowlingRefund(base);

    const refundCalls = calls.filter((c) => c.url.endsWith("/refunds"));
    expect(refundCalls).toHaveLength(1);
    expect((refundCalls[0].body as { payment_id: string }).payment_id).toBe("PAY_DEP");
    // Owner convention: the deposit/cash leg carries the portal journal key.
    expect((refundCalls[0].body as { reason: string }).reason).toBe("Refund: Reservation Deposit");
    expect(res.refundedCents).toBe(5000);
  });

  it("refuses outright when the gift card has no balance to refund", async () => {
    const calls = mockSquare({
      giftCard: () => json({ gift_card: { balance_money: { amount: 0 } } }),
    });
    await expect(processSquareBowlingRefund(base)).rejects.toThrow(/no balance/i);
    expect(calls.filter((c) => c.url.endsWith("/refunds"))).toHaveLength(0);
  });
});
