import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { reserveBaseKey } from "./reserve-idempotency";

describe("reserveBaseKey", () => {
  it("is deterministic — same seed always yields the same key", () => {
    const billId = "63000000003750208";
    expect(reserveBaseKey(billId)).toBe(reserveBaseKey(billId));
  });

  it("matches sha256(seed).slice(0,16) — the contract the reconcile cron relies on", () => {
    // The cron recomputes the baseKey from the stored bill id to replay the SAME
    // gift card. If this formula ever changes, both reserve paths AND the cron
    // must change together (they all import this one function) — this pins it.
    const billId = "63000000003750208";
    const expected = createHash("sha256").update(billId).digest("hex").slice(0, 16);
    expect(reserveBaseKey(billId)).toBe(expected);
  });

  it("is 16 hex chars — well under Square's 45-char idempotency_key limit", () => {
    const key = reserveBaseKey("63000000003750208");
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    // Longest derived key is `payorder-` (9) + 16 = 25 chars.
    expect(`payorder-${key}`.length).toBeLessThan(45);
  });

  it("distinct bills produce distinct keys (no cross-bill collision in practice)", () => {
    expect(reserveBaseKey("63000000003750208")).not.toBe(reserveBaseKey("63000000003750209"));
  });

  it("handles the unified pure-bowling fallback seeds (QAMF hold / square order id)", () => {
    const holdId = "9172-abc123";
    const orderId = "sqOrder_XYZ";
    expect(reserveBaseKey(holdId)).toMatch(/^[0-9a-f]{16}$/);
    expect(reserveBaseKey(orderId)).not.toBe(reserveBaseKey(holdId));
  });
});
