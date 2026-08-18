import { describe, it, expect } from "vitest";
import { resolveScreenConfig } from "./defaults";
import type { ScreenConfig } from "./types";

const board = (resultsBoard: ScreenConfig["resultsBoard"]): ScreenConfig => ({
  playlist: [{ scene: "race-results", slots: 1 }],
  resultsBoard,
});

describe("resultsBoard.role", () => {
  it("defaults to last-race, so a wall saved before the field existed is unchanged", () => {
    const r = resolveScreenConfig(board({ track: "blue" }), "FT");
    expect(r.resultsBoard).toEqual({ track: "blue", role: "last-race", ranges: ["today"] });
  });

  it("switches only on the exact literal", () => {
    expect(
      resolveScreenConfig(board({ track: "blue", role: "top-times" }), "FT").resultsBoard?.role,
    ).toBe("top-times");
  });

  it("treats a typo or a newer deploy's value as last-race, never as a leaderboard", () => {
    const cfg = board({ track: "blue", role: "toptimes" as never });
    expect(resolveScreenConfig(cfg, "FT").resultsBoard?.role).toBe("last-race");
  });

  it("stays null when no track is picked, so the board shows its setup notice", () => {
    expect(resolveScreenConfig(board(undefined), "FT").resultsBoard).toBeNull();
    expect(resolveScreenConfig(board({ track: "purple" as never }), "FT").resultsBoard).toBeNull();
  });
});

describe("resultsBoard.ranges", () => {
  const ranges = (v: unknown) =>
    resolveScreenConfig(board({ track: "blue", role: "top-times", ranges: v as never }), "FT")
      .resultsBoard?.ranges;

  it("keeps the saved order — a wall may deliberately open on the month", () => {
    expect(ranges(["month", "today"])).toEqual(["month", "today"]);
  });

  it("drops repeats, which would otherwise buy one window two slots", () => {
    expect(ranges(["today", "today", "week"])).toEqual(["today", "week"]);
  });

  it("drops windows this board does not offer", () => {
    // `year` and `alltime` are real RecordTimeRange values, and belong to the
    // kiosk hub — not to a wall.
    expect(ranges(["today", "year", "alltime", "nonsense"])).toEqual(["today"]);
  });

  it("falls back to today rather than to an empty rotation", () => {
    // An empty list would render no panel at all — a dark screen.
    expect(ranges([])).toEqual(["today"]);
    expect(ranges(undefined)).toEqual(["today"]);
    expect(ranges("today")).toEqual(["today"]);
  });

  it("resolves ranges even on a last-race board, so toggling the role cannot yield an empty list", () => {
    expect(resolveScreenConfig(board({ track: "red" }), "FT").resultsBoard?.ranges).toEqual([
      "today",
    ]);
  });
});
