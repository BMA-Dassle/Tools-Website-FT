import { describe, expect, it } from "vitest";
import {
  bowlerPatchBody,
  firstBowlerIssue,
  hasAnyBowlerName,
  isRealBowlerName,
  prefillBowlers,
  rentalCount,
  type CheckinBowlerRow,
} from "./bowler-details";

const row = (over: Partial<CheckinBowlerRow>): CheckinBowlerRow => ({
  slot: 1,
  name: "",
  shoeSize: null,
  bumpers: null,
  ...over,
});

describe("prefill (mirrors web BowlingCheckin)", () => {
  it("hides 'Bowler N' bootstrap labels but keeps real names", () => {
    const rows = prefillBowlers([
      { slot: 1, name: "Bowler 1" },
      { slot: 2, name: "Sara O'Neil", shoeSize: "Female 8", bumpers: true },
      { slot: 3, name: null },
    ]);
    expect(rows[0].name).toBe("");
    expect(rows[1]).toEqual({ slot: 2, name: "Sara O'Neil", shoeSize: "Female 8", bumpers: true });
    expect(rows[2].name).toBe("");
  });

  it("keeps bumpers tri-state and normalizes empty shoe strings to null", () => {
    const rows = prefillBowlers([{ slot: 1, shoeSize: "", bumpers: null }]);
    expect(rows[0].shoeSize).toBeNull();
    expect(rows[0].bumpers).toBeNull();
  });

  it("isRealBowlerName rejects placeholders and blanks", () => {
    expect(isRealBowlerName("Bowler 3")).toBe(false);
    expect(isRealBowlerName("  ")).toBe(false);
    expect(isRealBowlerName(null)).toBe(false);
    expect(isRealBowlerName("Bo")).toBe(true);
  });
});

describe("hard rules (web parity)", () => {
  it("a rental size without a name is the first issue, by slot", () => {
    const issue = firstBowlerIssue(
      [row({ slot: 1, name: "Eric" }), row({ slot: 2, shoeSize: "Male 10" })],
      4,
    );
    expect(issue).toEqual({ kind: "name-needed", slot: 2 });
  });

  it("rentals over the allowance are refused", () => {
    const rows = [
      row({ slot: 1, name: "A", shoeSize: "Male 9" }),
      row({ slot: 2, name: "B", shoeSize: "Female 7" }),
    ];
    expect(firstBowlerIssue(rows, 1)).toEqual({ kind: "over-allowance", allowed: 1 });
    expect(firstBowlerIssue(rows, 2)).toBeNull();
  });

  it("no shoes anywhere → nothing to complain about, whatever the allowance", () => {
    expect(firstBowlerIssue([row({ slot: 1, name: "A" })], 0)).toBeNull();
  });

  it("hasAnyBowlerName arms the finish button only on a real name", () => {
    expect(hasAnyBowlerName([row({ slot: 1 }), row({ slot: 2 })])).toBe(false);
    expect(hasAnyBowlerName([row({ slot: 1, name: "Mia" })])).toBe(true);
  });

  it("rentalCount ignores null and empty", () => {
    expect(
      rentalCount([
        row({ slot: 1, shoeSize: "Male 9" }),
        row({ slot: 2, shoeSize: null }),
        row({ slot: 3, shoeSize: "" }),
      ]),
    ).toBe(1);
  });
});

describe("PATCH body", () => {
  it("trims names to null, empty shoes to null, bumpers pass through tri-state", () => {
    const body = bowlerPatchBody([
      row({ slot: 1, name: "  Eric  ", shoeSize: "Male 10.5", bumpers: false }),
      row({ slot: 2, name: "   ", shoeSize: "", bumpers: null }),
    ]);
    expect(body.players).toEqual([
      { slot: 1, name: "Eric", shoeSize: "Male 10.5", bumpers: false },
      { slot: 2, name: null, shoeSize: null, bumpers: null },
    ]);
  });
});
