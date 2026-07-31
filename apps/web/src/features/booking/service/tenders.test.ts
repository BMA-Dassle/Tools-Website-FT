import { describe, expect, it } from "vitest";

import {
  MAX_CARD_TENDERS,
  MAX_GIFT_CARD_TENDERS,
  MAX_TOTAL_TENDERS,
  TenderPlanError,
  TendersRequestSchema,
  cancelKey,
  cardAuthKey,
  gcAuthKey,
  payOrderKey,
  planTenderAmounts,
} from "./tenders";

const gc = (token: string, viaLookup = false) =>
  viaLookup
    ? { kind: "gift_card" as const, lookupToken: token.padEnd(16, "x") }
    : { kind: "gift_card" as const, nonce: token };
const card = (sourceId: string, amountCents?: number) => ({
  kind: "card" as const,
  sourceId,
  ...(amountCents != null ? { amountCents } : {}),
});

describe("TendersRequestSchema", () => {
  it("accepts the common shapes", () => {
    expect(TendersRequestSchema.safeParse([card("cnon:1")]).success).toBe(true);
    expect(TendersRequestSchema.safeParse([gc("n1")]).success).toBe(true);
    expect(TendersRequestSchema.safeParse([gc("n1"), card("cnon:1")]).success).toBe(true);
    expect(
      TendersRequestSchema.safeParse([
        gc("n1"),
        gc("tok-a", true),
        card("cnon:1", 1000),
        card("cnon:2"),
      ]).success,
    ).toBe(true);
  });

  it("rejects an empty list and over-cap lists", () => {
    expect(TendersRequestSchema.safeParse([]).success).toBe(false);
    const overTotal = Array.from({ length: MAX_TOTAL_TENDERS + 1 }, (_, i) =>
      i < 3 ? gc(`n${i}`) : card(`cnon:${i}`, 100),
    );
    expect(TendersRequestSchema.safeParse(overTotal).success).toBe(false);
    const sixGcs = Array.from({ length: MAX_GIFT_CARD_TENDERS + 1 }, (_, i) => gc(`n${i}`));
    expect(TendersRequestSchema.safeParse(sixGcs).success).toBe(false);
    const fiveCards = Array.from({ length: MAX_CARD_TENDERS + 1 }, (_, i) =>
      card(`cnon:${i}`, 100),
    );
    expect(TendersRequestSchema.safeParse(fiveCards).success).toBe(false);
  });

  it("rejects a gift card with both or neither of nonce/lookupToken", () => {
    expect(
      TendersRequestSchema.safeParse([
        { kind: "gift_card", nonce: "n1", lookupToken: "t".padEnd(16, "t") },
      ]).success,
    ).toBe(false);
    expect(TendersRequestSchema.safeParse([{ kind: "gift_card" }]).success).toBe(false);
  });

  it("rejects gift cards after cards (owner ordering rule)", () => {
    expect(TendersRequestSchema.safeParse([card("cnon:1", 100), gc("n1")]).success).toBe(false);
  });

  it("rejects a non-last card without an amount", () => {
    expect(TendersRequestSchema.safeParse([card("cnon:1"), card("cnon:2")]).success).toBe(false);
    expect(TendersRequestSchema.safeParse([card("cnon:1", 100), card("cnon:2")]).success).toBe(
      true,
    );
  });

  it("rejects duplicate gift-card tokens", () => {
    expect(TendersRequestSchema.safeParse([gc("same"), gc("same")]).success).toBe(false);
  });
});

describe("planTenderAmounts", () => {
  it("drains gift cards greedily in order, card auto-fills the rest", () => {
    const plan = planTenderAmounts(10_000, [2_500, 3_000], [undefined]);
    expect(plan.gcAmounts).toEqual([2_500, 3_000]);
    expect(plan.cardAmounts).toEqual([4_500]);
  });

  it("caps a large gift card at the remaining total", () => {
    const plan = planTenderAmounts(10_000, [2_500, 9_000], []);
    expect(plan.gcAmounts).toEqual([2_500, 7_500]); // GC #2 capped at remaining
    expect(plan.cardAmounts).toEqual([]);
  });

  it("honors guest-entered card amounts with last-card auto-fill", () => {
    const plan = planTenderAmounts(10_000, [2_500], [3_000, undefined]);
    expect(plan.gcAmounts).toEqual([2_500]);
    expect(plan.cardAmounts).toEqual([3_000, 4_500]);
  });

  it("gift cards alone can cover the exact total", () => {
    const plan = planTenderAmounts(5_000, [2_500, 2_500], []);
    expect(plan.gcAmounts).toEqual([2_500, 2_500]);
    expect(plan.cardAmounts).toEqual([]);
  });

  it("throws GIFT_CARD_NOT_NEEDED when earlier tenders already cover the total", () => {
    expect(() => planTenderAmounts(1_000, [1_000, 500], [])).toThrowError(TenderPlanError);
    try {
      planTenderAmounts(1_000, [1_000, 500], []);
    } catch (e) {
      expect((e as TenderPlanError).code).toBe("GIFT_CARD_NOT_NEEDED");
    }
  });

  it("throws CARDS_NOT_NEEDED when gift cards cover everything but a card was sent", () => {
    try {
      planTenderAmounts(1_000, [1_500], [undefined]);
      expect.unreachable();
    } catch (e) {
      expect((e as TenderPlanError).code).toBe("CARDS_NOT_NEEDED");
    }
  });

  it("throws CARD_AMOUNT_INVALID for zero, negative, over-remaining, or missing mid-list amounts", () => {
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
        return "none";
      } catch (e) {
        return (e as TenderPlanError).code;
      }
    };
    expect(codeOf(() => planTenderAmounts(1_000, [], [0, undefined]))).toBe("CARD_AMOUNT_INVALID");
    expect(codeOf(() => planTenderAmounts(1_000, [], [-5, undefined]))).toBe("CARD_AMOUNT_INVALID");
    expect(codeOf(() => planTenderAmounts(1_000, [], [1_500]))).toBe("CARD_AMOUNT_INVALID");
    expect(codeOf(() => planTenderAmounts(1_000, [], [undefined, 500]))).toBe(
      "CARD_AMOUNT_INVALID",
    );
  });

  it("throws AMOUNTS_MISMATCH when entered amounts underpay the total", () => {
    try {
      planTenderAmounts(1_000, [], [300, 300]);
      expect.unreachable();
    } catch (e) {
      expect((e as TenderPlanError).code).toBe("AMOUNTS_MISMATCH");
    }
  });

  it("throws GIFT_CARD_EMPTY on a zero-balance gift card", () => {
    try {
      planTenderAmounts(1_000, [0], [undefined]);
      expect.unreachable();
    } catch (e) {
      expect((e as TenderPlanError).code).toBe("GIFT_CARD_EMPTY");
    }
  });

  it("guards the total and tender count", () => {
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
        return "none";
      } catch (e) {
        return (e as TenderPlanError).code;
      }
    };
    expect(codeOf(() => planTenderAmounts(0, [100], []))).toBe("INVALID_AMOUNT");
    expect(codeOf(() => planTenderAmounts(10.5, [100], []))).toBe("INVALID_AMOUNT");
    expect(codeOf(() => planTenderAmounts(100, [], []))).toBe("NO_TENDER");
    expect(
      codeOf(() =>
        planTenderAmounts(
          10_000,
          Array.from({ length: 3 }, () => 100),
          Array.from({ length: 3 }, () => 100),
        ),
      ),
    ).toBe("TOO_MANY_TENDERS");
  });
});

describe("idempotency key scheme", () => {
  const baseKey = "0123456789abcdef"; // 16 hex like reserveBaseKey

  it("stays within Square's 45-char limit (worst case: attempt 99)", () => {
    expect(gcAuthKey(baseKey, 9, "gftc:x".repeat(4), 99).length).toBeLessThanOrEqual(45);
    expect(cardAuthKey(baseKey, 9, "cnon:y".repeat(6), 99).length).toBeLessThanOrEqual(45);
    expect(payOrderKey(baseKey, ["p1", "p2", "p3"]).length).toBeLessThanOrEqual(45);
    expect(cancelKey(baseKey, "payment_id_long_x".repeat(2)).length).toBeLessThanOrEqual(45);
  });

  it("varies by index AND source — same slot new card gets a fresh key", () => {
    expect(gcAuthKey(baseKey, 0, "a")).not.toBe(gcAuthKey(baseKey, 1, "a"));
    expect(cardAuthKey(baseKey, 0, "a")).not.toBe(cardAuthKey(baseKey, 0, "b"));
    expect(cardAuthKey(baseKey, 0, "a")).toBe(cardAuthKey(baseKey, 0, "a"));
  });

  it("attempt salt frees a STABLE source after an unwind burned its key", () => {
    // A gift card resolves to the same gftc: id every time — only the attempt
    // salt distinguishes retry N+1 from the canceled attempt N (burned-key
    // lesson, 2026-07-25).
    expect(gcAuthKey(baseKey, 0, "gftc:same")).not.toBe(gcAuthKey(baseKey, 0, "gftc:same", 1));
    expect(cardAuthKey(baseKey, 0, "ccof:saved")).not.toBe(
      cardAuthKey(baseKey, 0, "ccof:saved", 1),
    );
    // Same attempt = same key (true double-POST still dedups).
    expect(gcAuthKey(baseKey, 0, "gftc:same", 2)).toBe(gcAuthKey(baseKey, 0, "gftc:same", 2));
  });

  it("payOrder key varies with the payment-id SET (retry after a swap = fresh key)", () => {
    expect(payOrderKey(baseKey, ["p1", "p2"])).not.toBe(payOrderKey(baseKey, ["p1", "p3"]));
    expect(payOrderKey(baseKey, ["p1", "p2"])).toBe(payOrderKey(baseKey, ["p1", "p2"]));
  });

  it("is namespace-disjoint from the legacy single-tender keys", () => {
    // Legacy: pay-gc-<baseKey>, pay-card-<baseKey>-<h8>, payorder-<baseKey>,
    // cancel-gc-<baseKey>. Indexed infixes / new prefixes can never collide.
    expect(gcAuthKey(baseKey, 0, "a")).not.toBe(`pay-gc-${baseKey}`);
    expect(payOrderKey(baseKey, ["p"]).startsWith("payord2-")).toBe(true);
    expect(cancelKey(baseKey, "p").startsWith("cxl-")).toBe(true);
  });
});
