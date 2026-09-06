import { describe, expect, it } from "vitest";
import {
  appendGrantedCredits,
  creditBalancesFromDeposits,
  creditBalancesFromOverview,
  memberEligibleCreditTotal,
} from "./race-credits";

const WEEKDAY_KIND = "12744867";
const ANYTIME_KIND = "12744871";

describe("appendGrantedCredits", () => {
  it("appends a fresh row whose kind round-trips through name resolution", () => {
    const rows = appendGrantedCredits(undefined, ANYTIME_KIND, 3);
    expect(rows).toEqual([{ kind: "Anytime Race Credit", balance: 3 }]);
    // The whole point: surfaces reading the snapshot must see the grant.
    expect(memberEligibleCreditTotal(rows, "2026-07-18")).toBe(3);
  });

  it("merges into an existing row of the same credit kind", () => {
    const rows = appendGrantedCredits(
      [{ kind: "Credit - Race Anytime", balance: 1 }],
      ANYTIME_KIND,
      3,
    );
    expect(rows).toEqual([{ kind: "Credit - Race Anytime", balance: 4 }]);
  });

  it("preserves unrelated rows and never mutates the input", () => {
    const input = [{ kind: "Race Membership", balance: 8 }];
    const rows = appendGrantedCredits(input, WEEKDAY_KIND, 3);
    expect(rows).toEqual([
      { kind: "Race Membership", balance: 8 },
      { kind: "Weekday Race Credit", balance: 3 },
    ]);
    expect(input).toHaveLength(1);
  });

  it("returns the snapshot unchanged for an unknown kind or non-positive count", () => {
    const input = [{ kind: "Race Membership", balance: 8 }];
    expect(appendGrantedCredits(input, "999", 3)).toEqual(input);
    expect(appendGrantedCredits(input, ANYTIME_KIND, 0)).toEqual(input);
  });
});

describe("creditBalancesFromOverview", () => {
  it("derives the same balances from an on-site DPS_OVERVIEW read as the cloud shape", () => {
    // The real 2026-09-05 case: a staff Race Comp on the on-site ledger.
    const overview = [
      { OUT_DPK_ID: 11260967, OUT_DPK_NAME: "Credit - Race Comp", OUT_DPS_AMOUNT: 2 },
      { OUT_DPK_ID: -1, OUT_DPK_NAME: "money", OUT_DPS_AMOUNT: 5 }, // not a credit kind
      { OUT_DPK_ID: 12744871, OUT_DPK_NAME: "Credit - Race Anytime", OUT_DPS_AMOUNT: 0 }, // spent
    ];
    const fromOverview = creditBalancesFromOverview(overview);
    expect(fromOverview).toEqual([{ kind: "Credit - Race Comp", balance: 2 }]);
    // Both sources must agree — the checkout can read either.
    const fromHistory = creditBalancesFromDeposits([
      { depositKind: "Credit - Race Comp", balance: 2 },
      { depositKind: "money", balance: 5 },
      { depositKind: "Credit - Race Anytime", balance: 0 },
    ]);
    expect(fromOverview).toEqual(fromHistory);
  });

  it("is null-safe on malformed rows and non-arrays", () => {
    expect(creditBalancesFromOverview(null)).toEqual([]);
    expect(creditBalancesFromOverview(undefined)).toEqual([]);
    expect(
      creditBalancesFromOverview([
        {},
        { OUT_DPK_NAME: null, OUT_DPS_AMOUNT: 3 },
        { OUT_DPK_NAME: "Credit - Race Weekday", OUT_DPS_AMOUNT: null },
      ]),
    ).toEqual([]);
  });
});
