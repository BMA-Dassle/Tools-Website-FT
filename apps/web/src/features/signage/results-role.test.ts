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
    expect(r.resultsBoard).toEqual({ track: "blue", role: "last-race", ranges: ["month"] });
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

  it("accepts every window /leaderboards offers, and nothing else", () => {
    // The wall reports the same hall of fame the website does (owner
    // 2026-08-18), so `year` and `alltime` are wall windows now — but a value
    // from a newer deploy, or a typo, still has to fall away rather than buy
    // itself a slot of the rotation.
    expect(ranges(["today", "week", "month", "year", "alltime"])).toEqual([
      "today",
      "week",
      "month",
      "year",
      "alltime",
    ]);
    expect(ranges(["year", "nonsense"])).toEqual(["year"]);
  });

  it("falls back to the month rather than to an empty rotation", () => {
    // An empty list would render no panel at all — a dark screen. The month is
    // the fallback because it is what /leaderboards opens on; "today" reads as
    // the session that just finished, which is the board next door's job.
    expect(ranges([])).toEqual(["month"]);
    expect(ranges(undefined)).toEqual(["month"]);
    expect(ranges("today")).toEqual(["month"]);
  });

  it("resolves ranges even on a last-race board, so toggling the role cannot yield an empty list", () => {
    expect(resolveScreenConfig(board({ track: "red" }), "FT").resultsBoard?.ranges).toEqual([
      "month",
    ]);
  });
});
