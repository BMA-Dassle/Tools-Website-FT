import { describe, it, expect } from "vitest";
import { paymentAgreementLines } from "@/lib/contract-pdf";

/**
 * The signed PDF is the record of what the guest agreed to. These lines used to be
 * hardcoded, so every contract — including a re-signed, already-paid-in-full one — asserted
 * a 50% deposit and a balance charged 72 hours out (event 3370, 2026-09-11).
 */

const row = (over: Record<string, number | boolean>) => ({
  approval_required: false,
  deposit_due_cents: 51440,
  total_cents: 102879,
  collected_cents: 51440,
  ...over,
});

describe("paymentAgreementLines", () => {
  it("keeps deposit + 72h wording while money is still owed", () => {
    const lines = paymentAgreementLines(row({}));
    expect(lines).toEqual([
      "I agree to make a 50% deposit via credit card after completing this document.",
      "I understand the remaining balance will be automatically charged 72 hours prior to the event.",
    ]);
  });

  it("says paid in full once nothing is outstanding", () => {
    // Event 3370 after re-signing: $2,042.88 total, $2,042.88 collected.
    const lines = paymentAgreementLines(
      row({ total_cents: 204288, collected_cents: 204288, deposit_due_cents: 204288 }),
    );
    expect(lines).toEqual(["I agree to the event total of $2,042.88, paid in full by card."]);
    expect(lines.join(" ")).not.toContain("50% deposit");
    expect(lines.join(" ")).not.toContain("72 hours");
  });

  it("never promises a 72h charge on an event that overpaid", () => {
    // Re-priced DOWN after payment — a refund is owed, not a future charge.
    const lines = paymentAgreementLines(row({ total_cents: 90000, collected_cents: 102879 }));
    expect(lines.join(" ")).not.toContain("72 hours");
    expect(lines).toHaveLength(1);
  });

  it("reports a post-paid account as billed after the event", () => {
    const lines = paymentAgreementLines(
      row({ approval_required: true, deposit_due_cents: 0, collected_cents: 0 }),
    );
    expect(lines).toEqual([
      "I understand this is a post-paid account and will be billed after the event.",
    ]);
  });

  it("still takes the deposit path for a post-paid flag that carries a real deposit", () => {
    // `approval_required` is written once and never recomputed, so it goes stale when an
    // event is converted OUT of post-paid; the deposit amount is the live fact.
    const lines = paymentAgreementLines(row({ approval_required: true, deposit_due_cents: 51440 }));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("50% deposit");
  });
});
