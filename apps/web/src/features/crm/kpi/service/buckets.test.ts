import { describe, expect, it } from "vitest";
import { normalizeStateName as normalizeFromStatuses } from "~/features/crm/statuses/service/bmi-states";
import {
  bookedPlusQuotedCents,
  bucketOf,
  conversionRate,
  isCancelledState,
  isConfirmedState,
  isDoubleCounted,
  isLeadState,
  isQuotedState,
  normalizeBmiStateName,
} from "./buckets";

/**
 * The portal's KPI buckets, reproduced. The C7 smoke puts this dashboard
 * beside the old portal one and demands every bucket within ±1 project WITH
 * every mismatch explained — which is only meaningful if these predicates give
 * the same answer the portal gives for the same Office state name.
 */

/** Real Office state names, suffixes and all. */
const OFFICE_NAMES = [
  "New Lead",
  "Contacted",
  "Quote",
  "Deposit Requested (HPFM)",
  "Send Contract",
  "Pending Signed",
  "Confirmation",
  "Confirmation + Waiver",
  "Confirmation + Waiver 2026",
  "Cancellation",
  "Kiosk Confirmation",
];

describe("normalizeBmiStateName", () => {
  it("drops a trailing parenthesised centre suffix", () => {
    expect(normalizeBmiStateName("Deposit Requested (HPFM)")).toBe("deposit requested");
    expect(normalizeBmiStateName("Confirmation (Naples)")).toBe("confirmation");
  });

  it("lowercases and collapses inner whitespace", () => {
    expect(normalizeBmiStateName("  Confirmation   +  Waiver ")).toBe("confirmation + waiver");
  });

  it("is empty for null, undefined and blank", () => {
    expect(normalizeBmiStateName(null)).toBe("");
    expect(normalizeBmiStateName(undefined)).toBe("");
    expect(normalizeBmiStateName("   ")).toBe("");
  });

  it("keeps a parenthesis that is not a trailing suffix", () => {
    expect(normalizeBmiStateName("Quote (rev 2) follow-up")).toBe("quote (rev 2) follow-up");
  });

  it("agrees with the statuses sub's copy over every real Office name", () => {
    // Two copies exist on purpose — this one must stay dependency-free so its
    // test is pure, the other imports the Office transport. They must agree.
    for (const name of OFFICE_NAMES) {
      expect(normalizeBmiStateName(name)).toBe(normalizeFromStatuses(name));
    }
  });
});

describe("buckets", () => {
  it("CONFIRMED is Confirmation and Confirmation + Waiver, suffixes included", () => {
    expect(isConfirmedState("Confirmation")).toBe(true);
    expect(isConfirmedState("Confirmation + Waiver")).toBe(true);
    expect(isConfirmedState("Confirmation + Waiver 2026")).toBe(true);
    expect(isConfirmedState("Quote")).toBe(false);
  });

  it("QUOTED is Quote and Deposit Requested", () => {
    expect(isQuotedState("Quote")).toBe(true);
    expect(isQuotedState("Deposit Requested (HPFM)")).toBe(true);
    expect(isQuotedState("Confirmation")).toBe(false);
  });

  it("LEAD is the whole funnel including cancellations", () => {
    for (const n of ["New Lead", "Contacted", "Quote", "Confirmation", "Cancellation"]) {
      expect(isLeadState(n)).toBe(true);
    }
    // Not one of the portal's states at all: excluded from every figure.
    expect(isLeadState("Kiosk Confirmation")).toBe(false);
    expect(bucketOf("Kiosk Confirmation")).toBeNull();
  });

  it("keeps the portal's deliberate double count of 'deposit requested'", () => {
    // It is money still in play AND a project that became a lead. The two
    // dashboards only agree if this stays double-counted; `isDoubleCounted`
    // exists so the smoke can cite it when a number differs.
    expect(isQuotedState("Deposit Requested")).toBe(true);
    expect(isLeadState("Deposit Requested")).toBe(true);
    expect(isDoubleCounted("Deposit Requested (HPN)")).toBe(true);
    expect(isDoubleCounted("Quote")).toBe(false);
  });

  it("bucketOf prefers confirmed and returns null outside the portal's set", () => {
    expect(bucketOf("Confirmation + Waiver")).toBe("confirmed");
    expect(bucketOf("Deposit Requested")).toBe("quoted");
    expect(bucketOf("Cancellation")).toBeNull();
    expect(bucketOf(null)).toBeNull();
  });

  it("recognises a cancellation", () => {
    expect(isCancelledState("Cancellation")).toBe(true);
    expect(isCancelledState("Cancellation (late)")).toBe(true);
    expect(isCancelledState("Confirmation")).toBe(false);
  });
});

describe("conversionRate", () => {
  it("is the portal's rounded percentage", () => {
    expect(conversionRate(31, 100)).toBe(31);
    expect(conversionRate(1, 3)).toBe(33);
  });

  it("is 0 rather than NaN when nothing came in", () => {
    expect(conversionRate(0, 0)).toBe(0);
    expect(conversionRate(5, 0)).toBe(0);
  });
});

describe("bookedPlusQuotedCents", () => {
  it("is the portal's totalRevenue — which is not revenue", () => {
    expect(bookedPlusQuotedCents(1_000_00, 250_00)).toBe(1_250_00);
  });
});
