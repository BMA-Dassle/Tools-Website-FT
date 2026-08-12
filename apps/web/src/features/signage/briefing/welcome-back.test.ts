import { describe, expect, it } from "vitest";
import { welcomeBackWindowOpen } from "./welcome-back";

describe("welcomeBackWindowOpen — the timing system's own truth, not a guess", () => {
  it("opens the moment the session's actualEnd is stamped", () => {
    expect(welcomeBackWindowOpen(Date.parse("2026-08-11T19:42:11-04:00"))).toBe(true);
  });

  it("stays open indefinitely — the next briefing retires it, not a clock", () => {
    // Owner 2026-08-11: "the return screen can stay up till the next briefing
    // video plays". An hour-old end is still a valid greeting if nothing else
    // has claimed the room; the day scope on the assignment lookup is what
    // stops yesterday's greeting reappearing tomorrow.
    const twoHoursAgo = Date.now() - 2 * 3600_000;
    expect(welcomeBackWindowOpen(twoHoursAgo)).toBe(true);
  });

  it("stays CLOSED while the session has not actually ended", () => {
    // actualEnd is stamped by the timing system only when the heat truly stops
    // — null means they are still briefing, gridding or racing.
    expect(welcomeBackWindowOpen(null)).toBe(false);
    expect(welcomeBackWindowOpen(NaN)).toBe(false);
  });
});
