import { describe, expect, it } from "vitest";
import { consumePriorSeats, type SeatHeat } from "./resume-seats";

const seat = (slotKey: string, heatId: string, productId: string | null = "p1") => ({
  slotKey,
  heat: { heatId, productId } as SeatHeat,
});

describe("consumePriorSeats", () => {
  it("leaves everything open when nobody was seated before", () => {
    const entries = [seat("a", "19:12"), seat("b", "19:12")];
    expect(consumePriorSeats(entries, [])).toEqual(entries);
  });

  it("frees only the remaining seat when ONE of two racers in a heat is seated", () => {
    // The bug this guards: filtering by heatId would close both seats and the
    // late arrival would be told there is no room.
    const entries = [seat("a", "19:12"), seat("b", "19:12")];
    const out = consumePriorSeats(entries, [{ heatId: "19:12", productId: "p1" }]);
    expect(out.map((e) => e.slotKey)).toEqual(["b"]);
  });

  it("closes a heat entirely when both its seats were taken", () => {
    const entries = [seat("a", "19:12"), seat("b", "19:12")];
    const out = consumePriorSeats(entries, [
      { heatId: "19:12", productId: "p1" },
      { heatId: "19:12", productId: "p1" },
    ]);
    expect(out).toEqual([]);
  });

  it("does not let one heat's prior seating close a DIFFERENT heat", () => {
    const entries = [seat("a", "19:12"), seat("b", "20:12")];
    const out = consumePriorSeats(entries, [{ heatId: "19:12", productId: "p1" }]);
    expect(out.map((e) => e.slotKey)).toEqual(["b"]);
  });

  it("treats the same time on a different product as a different seat", () => {
    const entries = [seat("a", "19:12", "junior"), seat("b", "19:12", "adult")];
    const out = consumePriorSeats(entries, [{ heatId: "19:12", productId: "adult" }]);
    expect(out.map((e) => e.slotKey)).toEqual(["a"]);
  });

  it("the W57387 shape: 6 racers seated across 2 heats leaves the 2nd heat free for latecomers", () => {
    const entries = [
      ...Array.from({ length: 6 }, (_, i) => seat(`h1-${i}`, "19:12")),
      ...Array.from({ length: 6 }, (_, i) => seat(`h2-${i}`, "20:12")),
    ];
    // First pass seated 4 people in heat 1 only.
    const prior = Array.from({ length: 4 }, () => ({ heatId: "19:12", productId: "p1" }));
    const out = consumePriorSeats(entries, prior);
    expect(out.filter((e) => e.heat.heatId === "19:12")).toHaveLength(2);
    expect(out.filter((e) => e.heat.heatId === "20:12")).toHaveLength(6);
  });

  it("ignores prior heats that match no open seat (stale data) without dropping real ones", () => {
    const entries = [seat("a", "19:12")];
    const out = consumePriorSeats(entries, [{ heatId: "18:00", productId: "p1" }]);
    expect(out.map((e) => e.slotKey)).toEqual(["a"]);
  });

  it("never returns more seats than it was given", () => {
    const entries = [seat("a", "19:12")];
    const prior = Array.from({ length: 5 }, () => ({ heatId: "19:12", productId: "p1" }));
    expect(consumePriorSeats(entries, prior)).toEqual([]);
  });
});
