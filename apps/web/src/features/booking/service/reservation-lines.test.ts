/**
 * The 2026-06-21 Pizza Bowl incident, pinned.
 *
 * Toppings and soda went to the Square order only. When they failed to attach
 * they were unrecoverable, because nothing had written them to Neon. The
 * bowling-only rail was fixed then; the unified rail (mixed carts — the
 * ordinary kiosk shape) was not, so the same loss was still live until
 * 2026-08-25. Both rails now share `rawFoodItemsToReservationLines`, and these
 * tests hold the contract they both depend on.
 */
import { describe, expect, it } from "vitest";
import { rawFoodItemsToReservationLines, type RawFoodItem } from "./reservation-lines";

const PIZZA = "2IKZB4O2HQBXWMTSUQ2SEKJY";
const SODA = "SJUBJLB4QGHIHCW5AKTTMLH7";

const oneLane: RawFoodItem[] = [
  { catalogObjectId: PIZZA, name: "Pizza Bowl Pizza", quantity: 1, note: "Pepperoni" },
  { catalogObjectId: SODA, name: "Pizza Bowl Soda Pitcher", quantity: 1, note: "Coke" },
];

describe("rawFoodItemsToReservationLines", () => {
  it("folds the guest's choice into the label — that string IS the record", () => {
    expect(rawFoodItemsToReservationLines(oneLane)).toEqual([
      { label: "Pizza Bowl Pizza — Pepperoni", quantity: 1, unitPriceCents: 0 },
      { label: "Pizza Bowl Soda Pitcher — Coke", quantity: 1, unitPriceCents: 0 },
    ]);
  });

  it("keeps per-lane notes distinct for a multi-lane party", () => {
    const twoLanes: RawFoodItem[] = [
      { catalogObjectId: PIZZA, name: "Pizza Bowl Pizza", quantity: 1, note: "Lane 1: Pepperoni" },
      { catalogObjectId: SODA, name: "Pizza Bowl Soda Pitcher", quantity: 1, note: "Lane 1: Coke" },
      { catalogObjectId: PIZZA, name: "Pizza Bowl Pizza", quantity: 1, note: "Lane 2: Sausage" },
      {
        catalogObjectId: SODA,
        name: "Pizza Bowl Soda Pitcher",
        quantity: 1,
        note: "Lane 2: Sprite",
      },
    ];
    const lines = rawFoodItemsToReservationLines(twoLanes);
    expect(lines.map((l) => l.label)).toEqual([
      "Pizza Bowl Pizza — Lane 1: Pepperoni",
      "Pizza Bowl Soda Pitcher — Lane 1: Coke",
      "Pizza Bowl Pizza — Lane 2: Sausage",
      "Pizza Bowl Soda Pitcher — Lane 2: Sprite",
    ]);
    // A lane's choice must never be collapsed into another lane's.
    expect(new Set(lines.map((l) => l.label)).size).toBe(4);
  });

  it("omits the dash when the guest made no choice", () => {
    expect(
      rawFoodItemsToReservationLines([
        { catalogObjectId: PIZZA, name: "Pizza Bowl Pizza", quantity: 1 },
      ]),
    ).toEqual([{ label: "Pizza Bowl Pizza", quantity: 1, unitPriceCents: 0 }]);
  });

  it("moves no money — every line is $0", () => {
    for (const line of rawFoodItemsToReservationLines(oneLane)) {
      expect(line.unitPriceCents).toBe(0);
    }
  });

  it("carries no squareProductId, so the day-of order map skips these lines", () => {
    // Present-and-undefined would also be skipped, but absence is the contract
    // the product-backed Square map was written against.
    for (const line of rawFoodItemsToReservationLines(oneLane)) {
      expect(line.squareProductId).toBeUndefined();
    }
  });

  it("preserves quantity rather than assuming one per line", () => {
    expect(
      rawFoodItemsToReservationLines([
        { catalogObjectId: SODA, name: "Pizza Bowl Soda Pitcher", quantity: 3, note: "Coke" },
      ])[0].quantity,
    ).toBe(3);
  });

  it("treats an empty cart, null and undefined alike — never throws", () => {
    expect(rawFoodItemsToReservationLines([])).toEqual([]);
    expect(rawFoodItemsToReservationLines(null)).toEqual([]);
    expect(rawFoodItemsToReservationLines(undefined)).toEqual([]);
  });
});
