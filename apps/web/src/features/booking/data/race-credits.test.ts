import { describe, expect, it } from "vitest";
import { appendGrantedCredits, memberEligibleCreditTotal } from "./race-credits";

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
