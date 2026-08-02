import { describe, expect, it } from "vitest";
import {
  addOnePendingCard,
  addPendingCards,
  clearDispensedCards,
  removeOnePendingCard,
  removePendingCard,
} from "./pending-cards";

const A = { code: "HPW-A", tokens: 100 };
const B = { code: "HPW-B", tokens: 50 };

describe("addPendingCards", () => {
  it("appends new codes", () => {
    expect(addPendingCards([A], [B])).toEqual([A, B]);
  });

  it("never duplicates a code already pending (re-scan is a no-op)", () => {
    const prev = [A];
    expect(addPendingCards(prev, [{ ...A }])).toBe(prev); // same reference
  });

  it("mixed batch keeps only the genuinely new codes", () => {
    expect(addPendingCards([A], [{ ...A }, B])).toEqual([A, B]);
  });
});

describe("removePendingCard", () => {
  it("removes every leg of the code", () => {
    const multi = [A, { code: "HPW-A", tokens: 100 }, B];
    expect(removePendingCard(multi, "HPW-A")).toEqual([B]);
  });
});

describe("clearDispensedCards", () => {
  it("drops dispensed codes, keeps failed ones (way back stays open)", () => {
    expect(
      clearDispensedCards(
        [A, B],
        [
          { code: "HPW-A", loaded: true },
          { code: "HPW-B", loaded: false },
        ],
      ),
    ).toEqual([B]);
  });

  it("one loaded outcome clears ONE leg of a multi-card voucher, not all", () => {
    // The server spends one gz item per claim — the second leg is still owed
    // and must keep the pending tile alive.
    const twoLegs = [A, { code: "HPW-A", tokens: 100 }];
    expect(clearDispensedCards(twoLegs, [{ code: "HPW-A", loaded: true }])).toEqual([
      { code: "HPW-A", tokens: 100 },
    ]);
  });

  it("two loaded outcomes for the same code clear two legs", () => {
    const twoLegs = [A, { code: "HPW-A", tokens: 100 }, B];
    expect(
      clearDispensedCards(twoLegs, [
        { code: "HPW-A", loaded: true },
        { code: "HPW-A", loaded: true },
      ]),
    ).toEqual([B]);
  });

  it("ignores outcomes for codes not in the list (GZ walk-up baskets)", () => {
    expect(clearDispensedCards([A], [{ code: "HPW-Z", loaded: true }])).toEqual([A]);
  });
});

describe("qty stepper legs (owner 2026-08-02)", () => {
  it("removeOnePendingCard drops exactly one leg of the code", () => {
    const threeLegs = [A, { code: "HPW-A", tokens: 100 }, B];
    expect(removeOnePendingCard(threeLegs, "HPW-A")).toEqual([{ code: "HPW-A", tokens: 100 }, B]);
    expect(removeOnePendingCard([B], "HPW-A")).toEqual([B]);
  });

  it("addOnePendingCard appends without the whole-code dedupe", () => {
    expect(addOnePendingCard([A], { code: "HPW-A", tokens: 100 })).toEqual([
      A,
      { code: "HPW-A", tokens: 100 },
    ]);
  });
});
