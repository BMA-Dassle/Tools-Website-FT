import { describe, it, expect } from "vitest";
import { resolvePair, pairProblem, type PairableScreen } from "./pairing";

function screen(
  screenId: string,
  name: string,
  pairing?: { groupId: string; position: number; count: number } | null,
): PairableScreen {
  return { screenId, name, config: { pairing: pairing ?? null } };
}

const blue = screen("FT:7", "Blue Pit", { groupId: "ft-pit", position: 0, count: 2 });
const red = screen("FT:8", "Red Pit", { groupId: "ft-pit", position: 1, count: 2 });
const lone = screen("FT:3", "Red briefing room");

describe("pairing groups", () => {
  it("orders a pair by position — 0 is the LEFT monitor", () => {
    // Deliberately passed right-first: row order must not decide which board
    // ends up on which side of a wall.
    const pair = resolvePair([red, blue, lone], "FT:8");
    expect(pair?.left.screenId).toBe("FT:7");
    expect(pair?.right.screenId).toBe("FT:8");
    expect(pair?.groupId).toBe("ft-pit");
  });

  it("resolves the same pair from EITHER screen", () => {
    const fromBlue = resolvePair([blue, red], "FT:7");
    const fromRed = resolvePair([blue, red], "FT:8");
    expect(fromBlue?.left.screenId).toBe(fromRed?.left.screenId);
    expect(fromBlue?.right.screenId).toBe(fromRed?.right.screenId);
  });

  it("is null for a screen with no pairing at all", () => {
    expect(resolvePair([blue, red, lone], "FT:3")).toBeNull();
    expect(pairProblem([blue, red, lone], "FT:3")).toContain("not in a pairing group");
  });

  it("is null for a half-finished group of one", () => {
    // A launcher built from this would drive one monitor and leave the other
    // dark, which is worse than not offering the button.
    const orphan = screen("FT:7", "Blue Pit", { groupId: "ft-pit", position: 0, count: 2 });
    expect(resolvePair([orphan, lone], "FT:7")).toBeNull();
    expect(pairProblem([orphan, lone], "FT:7")).toContain("has 1 screen;");
  });

  it("is null for a group of three — a two-monitor player cannot express it", () => {
    const third = screen("FT:9", "Mega Pit", { groupId: "ft-pit", position: 2, count: 3 });
    expect(resolvePair([blue, red, third], "FT:7")).toBeNull();
    expect(pairProblem([blue, red, third], "FT:7")).toContain("has 3 screens;");
  });

  it("is null for an unknown screen id", () => {
    expect(resolvePair([blue, red], "FT:99")).toBeNull();
    expect(pairProblem([blue, red], "FT:99")).toBe("unknown screen");
  });

  it("breaks a position tie deterministically", () => {
    // Two screens both left at position 0 must not swap sides depending on row
    // order — that is intermittent wrongness nobody can reproduce.
    const a = screen("FT:8", "Red Pit", { groupId: "g", position: 0, count: 2 });
    const b = screen("FT:7", "Blue Pit", { groupId: "g", position: 0, count: 2 });
    expect(resolvePair([a, b], "FT:7")?.left.screenId).toBe("FT:7");
    expect(resolvePair([b, a], "FT:7")?.left.screenId).toBe("FT:7");
  });

  it("ignores screens in a DIFFERENT group", () => {
    const otherA = screen("FT:1", "Blue check-in", { groupId: "ft-tracks", position: 0, count: 2 });
    const otherB = screen("FT:2", "Red check-in", { groupId: "ft-tracks", position: 1, count: 2 });
    const pair = resolvePair([blue, red, otherA, otherB], "FT:7");
    expect(pair?.left.screenId).toBe("FT:7");
    expect(pair?.right.screenId).toBe("FT:8");
  });

  it("says nothing is wrong when a pair is complete", () => {
    expect(pairProblem([blue, red], "FT:7")).toBeNull();
  });
});
