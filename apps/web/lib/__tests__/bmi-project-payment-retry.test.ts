import { describe, it, expect } from "vitest";
import { computePostableCents } from "@/lib/bmi-project-payment-retry";

/**
 * These cases are the anti-double-post guard for the BMI project-payment retry
 * queue. The queue exists because the 2026-08-03 Office-auth outage silently
 * dropped two events' payments; the danger in fixing that with a retry is the
 * opposite error — posting money into a center's books twice when the original
 * call actually landed and only the response was lost.
 */
describe("computePostableCents", () => {
  it("posts the full amount when BMI recorded nothing (the outage case)", () => {
    // Fireservice: $1,772.56 deposit collected, BMI ledger empty, $3,545.12 owed.
    expect(
      computePostableCents({
        collectedCents: 177256,
        recordedCents: 0,
        balanceCents: 354512,
        amountCents: 177256,
      }),
    ).toBe(177256);
  });

  it("posts only the missing slice when BMI has an earlier payment", () => {
    // FSW: $730.25 collected, BMI already had the $388.86 July deposit.
    expect(
      computePostableCents({
        collectedCents: 73025,
        recordedCents: 38886,
        balanceCents: 38886,
        amountCents: 34139,
      }),
    ).toBe(34139);
  });

  it("posts nothing when the original call actually landed", () => {
    // The dangerous case: we saw an error, BMI recorded it anyway.
    expect(
      computePostableCents({
        collectedCents: 177256,
        recordedCents: 177256,
        balanceCents: 177256,
        amountCents: 177256,
      }),
    ).toBe(0);
  });

  it("posts nothing when BMI has MORE than we collected", () => {
    // Offline/POS payment on the same project — never claw back via a negative.
    expect(
      computePostableCents({
        collectedCents: 50000,
        recordedCents: 75000,
        balanceCents: 0,
        amountCents: 50000,
      }),
    ).toBe(0);
  });

  it("never pushes a project past settled, even with a real gap", () => {
    // BMI's total is lower than ours; balance caps the write.
    expect(
      computePostableCents({
        collectedCents: 100000,
        recordedCents: 0,
        balanceCents: 4747,
        amountCents: 100000,
      }),
    ).toBe(4747);
  });

  it("never posts more than the row's own payment", () => {
    // Gap is large (deposit AND balance both unposted) but this row is the deposit.
    expect(
      computePostableCents({
        collectedCents: 300000,
        recordedCents: 0,
        balanceCents: 300000,
        amountCents: 100000,
      }),
    ).toBe(100000);
  });

  it("lets two queued failures on one event settle independently", () => {
    // Row A = deposit $1,000, Row B = balance $2,000, nothing posted yet.
    const collectedCents = 300000;
    const balanceCents = 300000;

    const postA = computePostableCents({
      collectedCents,
      recordedCents: 0,
      balanceCents,
      amountCents: 100000,
    });
    expect(postA).toBe(100000);

    // Row B runs after A landed: ledger now shows the deposit.
    const postB = computePostableCents({
      collectedCents,
      recordedCents: postA,
      balanceCents: balanceCents - postA,
      amountCents: 200000,
    });
    expect(postB).toBe(200000);

    // Together they exactly reconstruct what we collected — no more, no less.
    expect(postA + postB).toBe(collectedCents);
  });

  it("falls back to the row amount when there is no quote to read", () => {
    expect(
      computePostableCents({
        collectedCents: null,
        recordedCents: 0,
        balanceCents: 50000,
        amountCents: 25000,
      }),
    ).toBe(25000);
  });

  it("still caps a quote-less row by BMI's balance", () => {
    expect(
      computePostableCents({
        collectedCents: null,
        recordedCents: 0,
        balanceCents: 1000,
        amountCents: 25000,
      }),
    ).toBe(1000);
  });

  it("returns 0 rather than a negative when BMI is already over-settled", () => {
    expect(
      computePostableCents({
        collectedCents: 10000,
        recordedCents: 10000,
        balanceCents: -2282,
        amountCents: 10000,
      }),
    ).toBe(0);
  });
});
