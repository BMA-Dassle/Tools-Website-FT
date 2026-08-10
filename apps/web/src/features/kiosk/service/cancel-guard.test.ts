/**
 * evaluateCancelGuard: the unwind may only release what is still merely held.
 * Blocked iff money moved (ledger captured/needs_review or any payment id)
 * AND no non-cancelled booking row exists AND no force override — the exact
 * captured-no-reserve shape of W59702 (2026-08-10) and Chung (2026-07-28).
 */
import { describe, expect, it } from "vitest";
import { evaluateCancelGuard } from "./cancel-guard";

describe("evaluateCancelGuard", () => {
  it("passes when no tender ledger row exists (pre-payment abandon)", () => {
    const v = evaluateCancelGuard({ ledger: null, activeBookingCount: 0, force: false });
    expect(v.blocked).toBe(false);
  });

  it("BLOCKS captured money with no booking row — the W59702 shape", () => {
    const v = evaluateCancelGuard({
      ledger: { state: "captured", paymentIdCount: 1 },
      activeBookingCount: 0,
      force: false,
    });
    expect(v.blocked).toBe(true);
    expect(v.reason).toContain("captured-no-reserve");
  });

  it("BLOCKS needs_review with no booking row", () => {
    const v = evaluateCancelGuard({
      ledger: { state: "needs_review", paymentIdCount: 0 },
      activeBookingCount: 0,
      force: false,
    });
    expect(v.blocked).toBe(true);
  });

  it("BLOCKS when payment ids exist even in an unexpected ledger state", () => {
    // A state value this module doesn't know about must not weaken the guard
    // when the payment set says money moved.
    const v = evaluateCancelGuard({
      ledger: { state: "voided", paymentIdCount: 2 },
      activeBookingCount: 0,
      force: false,
    });
    expect(v.blocked).toBe(true);
  });

  it("passes an open ledger with no payments (reader armed, never tapped)", () => {
    const v = evaluateCancelGuard({
      ledger: { state: "open", paymentIdCount: 0 },
      activeBookingCount: 0,
      force: false,
    });
    expect(v.blocked).toBe(false);
  });

  it("passes captured money WITH a booking row (normal post-booking cancel/refund)", () => {
    const v = evaluateCancelGuard({
      ledger: { state: "captured", paymentIdCount: 1 },
      activeBookingCount: 2,
      force: false,
    });
    expect(v.blocked).toBe(false);
  });

  it("passes with force override even in the blocked shape", () => {
    const v = evaluateCancelGuard({
      ledger: { state: "captured", paymentIdCount: 1 },
      activeBookingCount: 0,
      force: true,
    });
    expect(v.blocked).toBe(false);
    expect(v.reason).toBe("force override");
  });

  it("treats a null ledger state with payments as money moved", () => {
    const v = evaluateCancelGuard({
      ledger: { state: null, paymentIdCount: 1 },
      activeBookingCount: 0,
      force: false,
    });
    expect(v.blocked).toBe(true);
  });
});
