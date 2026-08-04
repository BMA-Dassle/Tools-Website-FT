import { describe, expect, it } from "vitest";
import {
  MAX_REFUND_SEQ,
  SQUARE_KEY_MAX,
  dealRefundKey,
  dealRefundSquareKeys,
  longestDerivedKeyLength,
} from "./refund-keys";

/** The real shape: randomBytes(8).toString("hex"). */
const BASE = "0123456789abcdef";

describe("dealRefundKey", () => {
  it("namespaces an attempt by sequence", () => {
    expect(dealRefundKey(BASE, 1)).toBe("0123456789abcdef-rf1");
    expect(dealRefundKey(BASE, 42)).toBe("0123456789abcdef-rf42");
  });

  it("is byte-identical on repeat, which is what makes a retry a no-op", () => {
    // Replaying the same key is the reconciliation: Square returns the ORIGINAL
    // refund rather than issuing a second one.
    expect(dealRefundKey(BASE, 3)).toBe(dealRefundKey(BASE, 3));
  });

  it("never collides across attempts on the same purchase", () => {
    const keys = Array.from({ length: MAX_REFUND_SEQ }, (_, i) => dealRefundKey(BASE, i + 1));
    expect(new Set(keys).size).toBe(MAX_REFUND_SEQ);
  });

  it("never collides with the charge's own keys", () => {
    // The purchase path uses `deal-order-<baseKey>` and authorizeMultiTender's
    // own keys; none carry an `-rf` infix.
    const key = dealRefundKey(BASE, 1);
    expect(key).not.toBe(`deal-order-${BASE}`);
    expect(key.startsWith("deal-order-")).toBe(false);
  });

  it("refuses a sequence outside the bounded range", () => {
    expect(() => dealRefundKey(BASE, 0)).toThrow(/out of range/);
    expect(() => dealRefundKey(BASE, MAX_REFUND_SEQ + 1)).toThrow(/out of range/);
    expect(() => dealRefundKey(BASE, 1.5)).toThrow(/out of range/);
  });

  it("refuses a base key that is not the 16-hex shape", () => {
    // A variable-width base is exactly how a key silently grows past Square's
    // limit in production and nowhere else.
    expect(() => dealRefundKey("short", 1)).toThrow(/16 hex/);
    expect(() => dealRefundKey(`${BASE}extra`, 1)).toThrow(/16 hex/);
    expect(() => dealRefundKey("ZZZZZZZZZZZZZZZZ", 1)).toThrow(/16 hex/);
  });
});

describe("derived Square keys", () => {
  it("stay under Square's limit at BOTH ends of the sequence range", () => {
    for (const seq of [1, MAX_REFUND_SEQ]) {
      const longest = longestDerivedKeyLength(dealRefundKey(BASE, seq));
      expect(longest).toBeLessThanOrEqual(SQUARE_KEY_MAX);
    }
  });

  it("keeps the four Square keys distinct from each other", () => {
    const k = dealRefundSquareKeys(dealRefundKey(BASE, 1));
    // returnOrder and cardRefund share a namespace but the helpers append
    // different suffixes (`-ret0` vs `-r0`), so the finished keys differ.
    expect(`${k.returnOrder}-ret0`).not.toBe(`${k.cardRefund}-r0`);
    expect(k.giftCardCreate).not.toBe(k.giftCardRefund);
  });

  it("keeps attempt 1 and attempt 2 fully disjoint", () => {
    const a = dealRefundSquareKeys(dealRefundKey(BASE, 1));
    const b = dealRefundSquareKeys(dealRefundKey(BASE, 2));
    for (const field of ["returnOrder", "cardRefund", "giftCardCreate", "giftCardRefund"] as const) {
      expect(a[field]).not.toBe(b[field]);
    }
  });

  it("accounts for the gift-card fallback suffix in the length bound", () => {
    // createDigitalGiftCard appends `-fb` when a custom GAN collides; the bound
    // has to cover the longest key that can actually reach Square.
    const k = dealRefundSquareKeys(dealRefundKey(BASE, MAX_REFUND_SEQ));
    expect(`${k.giftCardCreate}-fb`.length).toBeLessThanOrEqual(SQUARE_KEY_MAX);
  });
});
