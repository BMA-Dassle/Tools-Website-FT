import { describe, it, expect } from "vitest";
import { callIsSuppressed, type ClearedCall } from "./called-clear";

const cleared: ClearedCall = {
  sessionId: 19,
  calledAt: "2026-08-14T19:00:00-04:00",
  atMs: Date.parse("2026-08-14T19:02:00-04:00"),
};

describe("clearing the called heat", () => {
  it("swallows the very call that was cleared", () => {
    // THE BUG. Pandora keeps answering with session 19 for ~20 minutes after the
    // call, and the poller writes it back unconditionally, so Clear appeared to
    // do nothing at all (owner 2026-08-14).
    expect(callIsSuppressed(cleared, { sessionId: 19, calledAt: cleared.calledAt })).toBe(true);
  });

  it("keeps swallowing it on every later poll, not just the first", () => {
    // Same stamp arriving again is the same call, however many times it arrives.
    for (let i = 0; i < 5; i++) {
      expect(callIsSuppressed(cleared, { sessionId: 19, calledAt: cleared.calledAt })).toBe(true);
    }
  });

  it("lets the heat back the moment staff CALL IT AGAIN", () => {
    // "should have ability to delete session from system so it can be called
    // again" — a genuine re-call re-stamps calledAt, and a newer stamp outranks
    // the clear. No second press, no waiting for a TTL.
    expect(
      callIsSuppressed(cleared, { sessionId: 19, calledAt: "2026-08-14T19:30:00-04:00" }),
    ).toBe(false);
  });

  it("never swallows a DIFFERENT heat", () => {
    // A clear is about one call, not a mute button on the track.
    expect(callIsSuppressed(cleared, { sessionId: 20, calledAt: cleared.calledAt })).toBe(false);
    expect(
      callIsSuppressed(cleared, { sessionId: 20, calledAt: "2026-08-14T18:00:00-04:00" }),
    ).toBe(false);
  });

  it("compares ids by value, not by type", () => {
    // The stored record carries a numeric session id while the rest of the app
    // carries text; a === would silently stop suppressing.
    expect(
      callIsSuppressed(
        { ...cleared, sessionId: 19 },
        { sessionId: Number("19"), calledAt: cleared.calledAt },
      ),
    ).toBe(true);
  });

  it("suppresses an OLDER stamp too — that is a stale carry, not a re-call", () => {
    expect(
      callIsSuppressed(cleared, { sessionId: 19, calledAt: "2026-08-14T18:45:00-04:00" }),
    ).toBe(true);
  });

  it("errs toward the clear when a stamp cannot be read", () => {
    // A board that ignores staff for twenty minutes is worse than one press of
    // "-> check-in" to put a heat back.
    expect(callIsSuppressed(cleared, { sessionId: 19, calledAt: "not a date" })).toBe(true);
    expect(callIsSuppressed(cleared, { sessionId: 19, calledAt: null })).toBe(true);
    expect(callIsSuppressed({ ...cleared, calledAt: null }, { sessionId: 19, calledAt: "x" })).toBe(
      true,
    );
  });

  it("does nothing when there is no tombstone", () => {
    expect(callIsSuppressed(null, { sessionId: 19, calledAt: cleared.calledAt })).toBe(false);
    expect(callIsSuppressed(undefined, { sessionId: 19, calledAt: cleared.calledAt })).toBe(false);
  });

  it("does nothing when there is no incoming call", () => {
    expect(callIsSuppressed(cleared, null)).toBe(false);
    expect(callIsSuppressed(cleared, undefined)).toBe(false);
  });
});
