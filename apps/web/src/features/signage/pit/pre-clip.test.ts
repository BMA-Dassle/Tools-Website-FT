import { describe, expect, it } from "vitest";
import { BIG_RACE_MAX_NORMAL, preClipFor, preClipNeedsRoster } from "./pre-clip";

describe("preClipFor", () => {
  it("plays the normal pre for a grid the normal clip covers", () => {
    expect(preClipFor("red", 1)).toBe("pre");
    expect(preClipFor("blue", BIG_RACE_MAX_NORMAL)).toBe("pre");
  });

  it("plays big past the threshold, on red and on blue", () => {
    expect(preClipFor("red", BIG_RACE_MAX_NORMAL + 1)).toBe("big");
    expect(preClipFor("blue", 12)).toBe("big");
  });

  it("an unreadable roster plays the normal pre, never nothing", () => {
    expect(preClipFor("red", null)).toBe("pre");
    expect(preClipFor("blue", 0)).toBe("pre");
  });

  /**
   * The 2026-08-18 outage: the Core's mega `big` names a file that is not on
   * the drive, so the player reported started → finished in 204ms and the pit
   * heard silence while the board said the pre had played.
   */
  it("MEGA always plays the normal pre — whatever the grid size", () => {
    for (const size of [1, BIG_RACE_MAX_NORMAL, BIG_RACE_MAX_NORMAL + 1, 12, 40, null]) {
      expect(preClipFor("mega", size)).toBe("pre");
    }
  });
});

describe("preClipNeedsRoster", () => {
  it("mega skips the roster read — the answer cannot change the clip", () => {
    expect(preClipNeedsRoster("mega")).toBe(false);
  });

  it("red and blue still need the grid size", () => {
    expect(preClipNeedsRoster("red")).toBe(true);
    expect(preClipNeedsRoster("blue")).toBe(true);
  });

  /** The two halves of the exemption must never disagree: any track that is
   *  told not to bother reading a roster must be one whose clip is fixed. */
  it("a track that skips the roster gets the same clip at every grid size", () => {
    for (const track of ["red", "blue", "mega"] as const) {
      if (preClipNeedsRoster(track)) continue;
      expect(preClipFor(track, 1)).toBe(preClipFor(track, 99));
    }
  });
});
