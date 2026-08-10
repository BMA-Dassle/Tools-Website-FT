import { describe, expect, it } from "vitest";
import { computeRaceItemPovQty, povUncoveredRacerCount } from "./race";
import type { BookingSession, RaceItem } from "../state/types";

/** Minimal RaceItem — only the fields computeRaceItemPovQty reads. */
function raceItem(over: Partial<RaceItem>): RaceItem {
  return {
    id: "r1",
    kind: "race",
    date: "2026-07-20",
    productIdAdult: null,
    productIdJunior: null,
    productTrackAdult: null,
    productTrackJunior: null,
    heats: [],
    packageIdAdult: null,
    packageIdJunior: null,
    povQuantity: 0,
    addons: [],
    rookiePack: null,
    ...over,
  } as RaceItem;
}

function heat(assignedTo: string, category: "adult" | "junior" = "adult") {
  return {
    heatId: "2026-07-20T18:00:00",
    productId: "p",
    category,
    track: null,
    assignedTo,
    bmiLineId: null,
  } as RaceItem["heats"][number];
}

function party(
  members: Array<{ id: string; category?: "adult" | "junior" }>,
): BookingSession["party"] {
  return members.map((m) => ({
    id: m.id,
    category: m.category ?? "adult",
  })) as unknown as BookingSession["party"];
}

describe("computeRaceItemPovQty", () => {
  it("individual Viewpoints: qty = item.povQuantity", () => {
    const item = raceItem({ povQuantity: 3, heats: [heat("a"), heat("b")] });
    expect(computeRaceItemPovQty(item, party([{ id: "a" }, { id: "b" }]))).toBe(3);
  });

  it("non-packaged item: povQuantity counts as-is regardless of racer mix", () => {
    const item = raceItem({ povQuantity: 2, heats: [heat("a"), heat("b")] });
    expect(computeRaceItemPovQty(item, party([{ id: "a" }, { id: "b" }]))).toBe(2);
  });

  it("Ultimate Qualifier package: 1 per unique racer even with 2 heats each", () => {
    const item = raceItem({
      packageIdAdult: "ultimate-qualifier-weekday",
      // UQ books Starter + Intermediate — 2 heats per racer, still 1 code each.
      heats: [heat("a"), heat("a"), heat("b"), heat("b")],
      povQuantity: 0,
    });
    expect(computeRaceItemPovQty(item, party([{ id: "a" }, { id: "b" }]))).toBe(2);
  });

  it("per-category packages: adult + junior variants each cover their own racers", () => {
    const item = raceItem({
      packageIdAdult: "ultimate-qualifier-weekday",
      packageIdJunior: "ultimate-qualifier-weekday-junior",
      heats: [heat("a", "adult"), heat("j1", "junior"), heat("j2", "junior")],
      povQuantity: 0,
    });
    const p = party([
      { id: "a", category: "adult" },
      { id: "j1", category: "junior" },
      { id: "j2", category: "junior" },
    ]);
    expect(computeRaceItemPovQty(item, p)).toBe(3);
  });

  it("fully packaged party suppresses the standalone povQuantity", () => {
    const item = raceItem({
      packageIdAdult: "rookie-pack-weekday",
      heats: [heat("a")],
      povQuantity: 5, // stale/leftover — must NOT add on a fully packaged item
    });
    expect(computeRaceItemPovQty(item, party([{ id: "a" }]))).toBe(1);
  });

  it("package + non-packaged remainder: category package racers + povQuantity", () => {
    // Adults packaged, juniors present WITHOUT a junior package → not fully
    // packaged → povQuantity (e.g. juniors' individual POV) adds on top.
    const item = raceItem({
      packageIdAdult: "ultimate-qualifier-weekday",
      heats: [heat("a", "adult"), heat("j1", "junior")],
      povQuantity: 1,
    });
    const p = party([
      { id: "a", category: "adult" },
      { id: "j1", category: "junior" },
    ]);
    expect(computeRaceItemPovQty(item, p)).toBe(2);
  });

  it("combo sessions ride povQuantity only — no package ids, no double count", () => {
    // ComboSteps sets povQuantity = includedPovPerRacer × racers; the helper
    // must count exactly that once.
    const item = raceItem({ povQuantity: 4, heats: [heat("a"), heat("b")] });
    expect(computeRaceItemPovQty(item, party([{ id: "a" }, { id: "b" }]))).toBe(4);
  });

  it("no POV anywhere → 0", () => {
    const item = raceItem({ heats: [heat("a")] });
    expect(computeRaceItemPovQty(item, party([{ id: "a" }]))).toBe(0);
  });

  it("package selected but no heats assigned yet → floor of 1 per packaged category", () => {
    const item = raceItem({ packageIdAdult: "ultimate-qualifier-weekday", heats: [] });
    expect(computeRaceItemPovQty(item, party([{ id: "a" }]))).toBe(1);
  });
});

describe("povUncoveredRacerCount", () => {
  it("no packages → every racer is uncovered", () => {
    const item = raceItem({});
    expect(povUncoveredRacerCount(item, party([{ id: "a" }, { id: "b" }]))).toBe(2);
  });

  it("adult package covers ONLY adults — juniors stay uncovered", () => {
    const item = raceItem({ packageIdAdult: "ultimate-qualifier-weekday" });
    const p = party([
      { id: "a1", category: "adult" },
      { id: "a2", category: "adult" },
      { id: "j1", category: "junior" },
    ]);
    expect(povUncoveredRacerCount(item, p)).toBe(1);
  });

  it("both categories packaged → 0 uncovered", () => {
    const item = raceItem({
      packageIdAdult: "rookie-pack-weekday",
      packageIdJunior: "rookie-pack-weekday-junior",
    });
    const p = party([
      { id: "a", category: "adult" },
      { id: "j", category: "junior" },
    ]);
    expect(povUncoveredRacerCount(item, p)).toBe(0);
  });

  it("members default to adult when category is unset", () => {
    const item = raceItem({ packageIdAdult: "ultimate-qualifier-weekday" });
    expect(povUncoveredRacerCount(item, party([{ id: "a" }]))).toBe(0);
  });
});
