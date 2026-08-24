import { describe, expect, it } from "vitest";
import { GREETING_WINDOW_MS } from "./return-greeting";
import { HARD_CAP_AFTER_END_MS, welcomeBackExpired, welcomeBackWindowOpen } from "./welcome-back";

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

/**
 * THE CEILING (owner 2026-08-24). The 2026-08-11 "no time ceiling" call left a
 * red room holding an exit sign for 30+ minutes with nobody in it, because the
 * only retiring condition was another group's arrival. These are the two ways a
 * greeting is now finished — and the cases that must NOT retire one early.
 */
describe("welcomeBackExpired", () => {
  const M = 60_000;
  const NOW = Date.parse("2026-08-24T03:30:00.000Z");
  const LINGER = 2 * M;

  it("retires the greeting a linger past the post-race call", () => {
    expect(
      welcomeBackExpired({
        actualEndMs: NOW - 30 * M,
        postPlayedAtMs: NOW - LINGER,
        lingerAfterMs: LINGER,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("keeps it up while the group is still inside that linger", () => {
    expect(
      welcomeBackExpired({
        actualEndMs: NOW - 30 * M,
        postPlayedAtMs: NOW - 30_000,
        lingerAfterMs: LINGER,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("greets a group that walks in LATE — the post starts the clock, not the flag", () => {
    // Tonight's real case: the flag fell 25 minutes before the post fired. The
    // greeting must still be up for the group the post just called in.
    expect(
      welcomeBackExpired({
        actualEndMs: NOW - 25 * M,
        postPlayedAtMs: NOW - 10_000,
        lingerAfterMs: LINGER,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("falls back to a hard cap when no post ever comes", () => {
    expect(
      welcomeBackExpired({
        actualEndMs: NOW - (HARD_CAP_AFTER_END_MS + 1),
        postPlayedAtMs: null,
        lingerAfterMs: LINGER,
        nowMs: NOW,
      }),
    ).toBe(true);
    expect(
      welcomeBackExpired({
        actualEndMs: NOW - (HARD_CAP_AFTER_END_MS - M),
        postPlayedAtMs: null,
        lingerAfterMs: LINGER,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("does not call an unstamped greeting expired — that is the open check's job", () => {
    expect(
      welcomeBackExpired({
        actualEndMs: null,
        postPlayedAtMs: null,
        lingerAfterMs: LINGER,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  /**
   * THE REGRESSION THAT MATTERS (owner 2026-08-24: "it actually cleared the
   * welcome-back screen before even playing the first message, that can't
   * happen"). The default linger and the greeting window are both two minutes,
   * so a ceiling measured on the linger alone killed the screen at the same
   * instant the clip's last chance did.
   */
  it("NEVER retires before the greeting's own window has closed", () => {
    // The clip is still waiting on its 45s fallback here — retiring now would
    // mean the group is never greeted at all.
    expect(
      welcomeBackExpired({
        actualEndMs: NOW - 10 * M,
        postPlayedAtMs: NOW - 40_000,
        lingerAfterMs: 30_000,
        nowMs: NOW,
      }),
    ).toBe(false);
    // And a staff-shortened linger cannot cut the window short either.
    for (const linger of [60_000, 30_000, 0]) {
      expect(
        welcomeBackExpired({
          actualEndMs: NOW - 10 * M,
          postPlayedAtMs: NOW - (GREETING_WINDOW_MS - 1_000),
          lingerAfterMs: linger,
          nowMs: NOW,
        }),
      ).toBe(false);
    }
    // One second past the window, with nothing asking for longer: done.
    expect(
      welcomeBackExpired({
        actualEndMs: NOW - 10 * M,
        postPlayedAtMs: NOW - (GREETING_WINDOW_MS + 1_000),
        lingerAfterMs: 30_000,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("honours a staff-widened linger rather than a constant of its own", () => {
    const wide = 5 * M;
    expect(
      welcomeBackExpired({
        actualEndMs: NOW - 30 * M,
        postPlayedAtMs: NOW - 3 * M,
        lingerAfterMs: wide,
        nowMs: NOW,
      }),
    ).toBe(false);
  });
});
