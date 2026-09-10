import { describe, expect, it } from "vitest";
import { BIG_RACE_MAX_NORMAL, preClipFor, preClipNeedsRoster } from "./pre-clip";

describe("preClipFor", () => {
  it("plays the normal pre for a grid the normal clip covers", () => {
    expect(preClipFor("red", 1)).toBe("pre");
    expect(preClipFor("blue", BIG_RACE_MAX_NORMAL)).toBe("pre");
    expect(preClipFor("mega", BIG_RACE_MAX_NORMAL)).toBe("pre");
  });

  it("plays big past the threshold, on every track", () => {
    expect(preClipFor("red", BIG_RACE_MAX_NORMAL + 1)).toBe("big");
    expect(preClipFor("blue", 12)).toBe("big");
    expect(preClipFor("mega", BIG_RACE_MAX_NORMAL + 1)).toBe("big");
  });

  it("an unreadable roster plays the normal pre, never nothing", () => {
    expect(preClipFor("red", null)).toBe("pre");
    expect(preClipFor("blue", 0)).toBe("pre");
    expect(preClipFor("mega", null)).toBe("pre");
  });

  /**
   * MEGA PLAYS BIG AGAIN (owner 2026-09-10). From 2026-08-18 it was pinned to
   * the normal pre because the Core's mega `big` entry named a file that was
   * not on the drive (started → finished in 204ms, silence in the pit). The
   * owner made the config and filename agree; a Mega grid is almost always
   * 8+, so this is the clip nearly every Mega heat now hears.
   */
  it("mega follows the same 8+ rule as red and blue", () => {
    for (const size of [1, BIG_RACE_MAX_NORMAL, null]) {
      expect(preClipFor("mega", size)).toBe(preClipFor("red", size));
    }
    for (const size of [BIG_RACE_MAX_NORMAL + 1, 12, 40]) {
      expect(preClipFor("mega", size)).toBe("big");
    }
  });
});

describe("preClipNeedsRoster", () => {
  it("every track needs the grid size — the clip depends on it everywhere", () => {
    expect(preClipNeedsRoster("red")).toBe(true);
    expect(preClipNeedsRoster("blue")).toBe(true);
    expect(preClipNeedsRoster("mega")).toBe(true);
  });

  /** The two halves must never disagree: any track that is told not to bother
   *  reading a roster must be one whose clip is fixed. */
  it("a track that skips the roster gets the same clip at every grid size", () => {
    for (const track of ["red", "blue", "mega"] as const) {
      if (preClipNeedsRoster(track)) continue;
      expect(preClipFor(track, 1)).toBe(preClipFor(track, 99));
    }
  });
});
