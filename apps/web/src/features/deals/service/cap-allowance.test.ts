/**
 * What a refund and a void each give back to the buyer's cap.
 *
 * `countPacksForBuyer` is SQL and needs a database, so the arithmetic it encodes
 * lives in `allowanceConsumed` and is asserted here. The query mirrors it —
 * `SUM(GREATEST(0, qty - refunded_packs))` filtered on the void columns — and the
 * two must stay in step, which is the point of pinning the intent this precisely.
 *
 * The regression that prompted this: when voids moved to `vouchers_voided_at`,
 * the cap query still filtered on the legacy `refunded_at` alone, so a voided
 * purchase stopped releasing the buyer's allowance at all.
 */
import { describe, expect, it } from "vitest";
import { allowanceConsumed } from "./refund-math";

const row = (patch: Partial<Parameters<typeof allowanceConsumed>[0]> = {}) => ({
  qty: 3,
  refundedPacks: 0,
  vouchersVoidedAt: null,
  ...patch,
});

describe("allowanceConsumed", () => {
  it("counts every pack of an untouched purchase", () => {
    expect(allowanceConsumed(row())).toBe(3);
  });

  it("gives back exactly the packs a PARTIAL refund returned, not all of them", () => {
    // Refund one of three and the buyer gets one slot back — the behaviour the
    // all-or-nothing legacy filter got wrong in both directions.
    expect(allowanceConsumed(row({ refundedPacks: 1 }))).toBe(2);
    expect(allowanceConsumed(row({ refundedPacks: 2 }))).toBe(1);
  });

  it("consumes nothing once fully refunded", () => {
    expect(allowanceConsumed(row({ refundedPacks: 3 }))).toBe(0);
  });

  it("consumes nothing once VOIDED — the guest kept nothing", () => {
    // The regression: a void writes only `vouchers_voided_at`, so a query reading
    // just `refunded_at` would keep charging the buyer's allowance forever.
    expect(allowanceConsumed(row({ vouchersVoidedAt: "2026-08-03T20:00:00.000Z" }))).toBe(0);
  });

  it("treats a void as total even when only some packs were refunded first", () => {
    expect(
      allowanceConsumed(row({ refundedPacks: 1, vouchersVoidedAt: "2026-08-03T20:00:00.000Z" })),
    ).toBe(0);
  });

  it("never returns negative allowance from bad data", () => {
    // GREATEST(0, …) in the SQL, Math.max(0, …) here.
    expect(allowanceConsumed(row({ qty: 1, refundedPacks: 5 }))).toBe(0);
  });

  it("handles a single-pack purchase at both ends", () => {
    expect(allowanceConsumed(row({ qty: 1 }))).toBe(1);
    expect(allowanceConsumed(row({ qty: 1, refundedPacks: 1 }))).toBe(0);
  });
});
