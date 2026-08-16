import { describe, it, expect } from "vitest";
import {
  clampHoldMs,
  GUIDE_CARDS,
  GUIDE_CARD_MS,
  GUIDE_HOLD_MAX_MS,
  GUIDE_HOLD_MIN_MS,
  GUIDE_TAKEOVER_MS,
  guideCardAt,
  qualifyBoardFor,
  takeoverState,
} from "./race-guide";

describe("guideCardAt", () => {
  it("leads with the shoe rule — it is the one that sends people back to the car", () => {
    expect(GUIDE_CARDS[0]).toBe("shoes");
    expect(guideCardAt(0)).toBe("shoes");
  });

  it("advances one card per interval and wraps", () => {
    expect(guideCardAt(GUIDE_CARD_MS)).toBe("lockers");
    expect(guideCardAt(GUIDE_CARD_MS * 2)).toBe("qualify");
    expect(guideCardAt(GUIDE_CARD_MS * 3)).toBe("night");
    expect(guideCardAt(GUIDE_CARD_MS * 4)).toBe("shoes");
  });

  it("holds the same card across the whole interval", () => {
    expect(guideCardAt(GUIDE_CARD_MS + 1)).toBe("lockers");
    expect(guideCardAt(GUIDE_CARD_MS * 2 - 1)).toBe("lockers");
  });

  it("two screens on the same clock show the same card", () => {
    const t = 1_700_000_123_456;
    expect(guideCardAt(t)).toBe(guideCardAt(t));
  });

  it("still names a card on a nonsense clock rather than rendering nothing", () => {
    expect(GUIDE_CARDS).toContain(guideCardAt(-1));
    expect(GUIDE_CARDS).toContain(guideCardAt(Number.NaN));
  });
});

describe("takeoverState", () => {
  const now = 1_700_000_000_000;

  it("is off when no send has happened", () => {
    expect(takeoverState({ briefedAtMs: null, nowMs: now })).toEqual({ on: false, remainingMs: 0 });
  });

  it("comes on the moment a heat is sent", () => {
    const s = takeoverState({ briefedAtMs: now, nowMs: now });
    expect(s.on).toBe(true);
    expect(s.remainingMs).toBe(GUIDE_TAKEOVER_MS);
  });

  it("counts down while it holds", () => {
    const s = takeoverState({ briefedAtMs: now - 30_000, nowMs: now });
    expect(s.on).toBe(true);
    expect(s.remainingMs).toBe(GUIDE_TAKEOVER_MS - 30_000);
  });

  it("drops out the instant the hold expires", () => {
    expect(takeoverState({ briefedAtMs: now - GUIDE_TAKEOVER_MS, nowMs: now }).on).toBe(false);
  });

  it("tolerates a send stamped a moment in the future — that is clock skew, not a bad send", () => {
    expect(takeoverState({ briefedAtMs: now + 3_000, nowMs: now }).on).toBe(true);
  });

  it("ignores a send stamped far in the future", () => {
    expect(takeoverState({ briefedAtMs: now + 60_000, nowMs: now }).on).toBe(false);
  });

  it("honours a per-screen hold", () => {
    const s = takeoverState({ briefedAtMs: now - 90_000, nowMs: now, holdMs: 60_000 });
    expect(s.on).toBe(false);
  });

  it("a stale send from hours ago never puts an instruction on the wall", () => {
    expect(takeoverState({ briefedAtMs: now - 3 * 3600_000, nowMs: now }).on).toBe(false);
  });
});

describe("clampHoldMs", () => {
  it("defaults when unset or unusable", () => {
    expect(clampHoldMs(undefined)).toBe(GUIDE_TAKEOVER_MS);
    expect(clampHoldMs("120")).toBe(GUIDE_TAKEOVER_MS);
    expect(clampHoldMs(Number.NaN)).toBe(GUIDE_TAKEOVER_MS);
  });

  it("refuses to pin the wall on one instruction all night", () => {
    expect(clampHoldMs(60 * 60_000)).toBe(GUIDE_HOLD_MAX_MS);
  });

  it("refuses to blink out before anyone has turned around", () => {
    expect(clampHoldMs(0)).toBe(GUIDE_HOLD_MIN_MS);
    expect(clampHoldMs(-5)).toBe(GUIDE_HOLD_MIN_MS);
  });

  it("passes a sensible value through", () => {
    expect(clampHoldMs(90_000)).toBe(90_000);
  });
});

describe("qualifyBoardFor", () => {
  it("gives Blue its own adult cutoffs", () => {
    const b = qualifyBoardFor("blue");
    expect(b.trackLabel).toBe("Blue Track");
    expect(b.adult).toEqual([
      { from: "Starter", to: "Intermediate", ms: 41_000 },
      { from: "Intermediate", to: "Pro", ms: 32_500 },
    ]);
  });

  it("gives Red its own — the numbers are the thing that differs between the two cards", () => {
    const r = qualifyBoardFor("red");
    expect(r.trackLabel).toBe("Red Track");
    expect(r.adult).toEqual([
      { from: "Starter", to: "Intermediate", ms: 46_000 },
      { from: "Intermediate", to: "Pro", ms: 37_000 },
    ]);
  });

  it("Blue and Red never show the same times", () => {
    const b = qualifyBoardFor("blue").adult.map((r) => r.ms);
    const r = qualifyBoardFor("red").adult.map((r) => r.ms);
    expect(b).not.toEqual(r);
  });

  it("uses Mega's own cutoffs on a Mega day", () => {
    expect(qualifyBoardFor("mega").adult).toEqual([
      { from: "Starter", to: "Intermediate", ms: 88_000 },
      { from: "Intermediate", to: "Pro", ms: 68_500 },
    ]);
  });

  it("carries the junior ladder, which is venue-wide rather than per track", () => {
    const b = qualifyBoardFor("blue");
    const r = qualifyBoardFor("red");
    expect(b.junior).toEqual([
      { from: "Junior Starter", to: "Junior Intermediate", ms: 75_000 },
      { from: "Junior Intermediate", to: "Junior Pro", ms: 45_000 },
    ]);
    expect(r.junior).toEqual(b.junior);
  });

  it("always has exactly the two adult steps — the card is built for two rows", () => {
    for (const t of ["blue", "red", "mega"] as const) {
      expect(qualifyBoardFor(t).adult).toHaveLength(2);
    }
  });
});
