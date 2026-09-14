import { describe, expect, it } from "vitest";
import { boardOrder, dealStep } from "./stepper";

describe("dealStep", () => {
  const order = ["L-1", "L-2", "L-3"];

  it("gives both neighbours in the middle", () => {
    expect(dealStep(order, "L-2")).toEqual({ prev: "L-1", next: "L-3", index: 2, total: 3 });
  });

  it("does NOT wrap at either end", () => {
    // A rep stepping a column has to be able to tell when they have finished
    // it; looping silently is how the same eight deals get worked twice.
    expect(dealStep(order, "L-1")).toMatchObject({ prev: null, next: "L-2" });
    expect(dealStep(order, "L-3")).toMatchObject({ prev: "L-2", next: null });
  });

  it("a deal that left the list under them gets no neighbours, not the first two", () => {
    // Real case: changing status from inside the drawer moves the card out of
    // the column being worked. Guessing would step somewhere never asked for.
    expect(dealStep(order, "L-99")).toEqual({ prev: null, next: null, index: 0, total: 3 });
  });

  it("is inert for one deal, an empty list, or no list at all", () => {
    expect(dealStep(["L-1"], "L-1")).toEqual({ prev: null, next: null, index: 1, total: 1 });
    expect(dealStep([], "L-1")).toMatchObject({ total: 0 });
    expect(dealStep(undefined, "L-1")).toMatchObject({ prev: null, next: null, total: 0 });
  });

  it("a repeated id never makes next land on the card already open", () => {
    // A lead shows up twice when a column and its swimlane both list it.
    expect(dealStep(["L-1", "L-2", "L-1", "L-3"], "L-2")).toMatchObject({
      prev: "L-1",
      next: "L-3",
      total: 3,
    });
  });
});

describe("boardOrder", () => {
  const publicIdOf = (id: string) => (id === "gone" ? null : `L-${id}`);

  it("reads column by column, top to bottom — the order on screen", () => {
    const columns = [
      { leadIds: ["1", "2"], lanes: null },
      { leadIds: ["3"], lanes: null },
    ];
    expect(boardOrder(columns, publicIdOf)).toEqual(["L-1", "L-2", "L-3"]);
  });

  it("follows the LANES when swimlanes are on, not the flat column list", () => {
    // With `?by=rep` the eye reads lane by lane; stepping by `leadIds` would
    // move in an order nobody can see.
    const columns = [
      {
        leadIds: ["1", "2", "3"],
        lanes: [{ leadIds: ["3"] }, { leadIds: ["1", "2"] }],
      },
    ];
    expect(boardOrder(columns, publicIdOf)).toEqual(["L-3", "L-1", "L-2"]);
  });

  it("drops a lead the client has no row for rather than emitting a hole", () => {
    const columns = [{ leadIds: ["1", "gone", "2"], lanes: null }];
    expect(boardOrder(columns, publicIdOf)).toEqual(["L-1", "L-2"]);
  });
});
