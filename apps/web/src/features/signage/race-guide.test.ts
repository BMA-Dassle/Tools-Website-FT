import { describe, it, expect } from "vitest";
import {
  clampHoldMs,
  GUIDE_CARD_MS,
  GUIDE_HOLD_MAX_MS,
  GUIDE_HOLD_MIN_MS,
  GUIDE_TAKEOVER_MS,
  guideCardAt,
  guideCardKey,
  guideCardsFor,
  pickTakeover,
  qualifyBoardFor,
  takeoverState,
  type GuideSend,
} from "./race-guide";

const BOTH = ["blue", "red"] as const;

describe("guideCardsFor", () => {
  it("is ONE rotation covering both tracks — not one screen each", () => {
    expect(guideCardsFor(BOTH).map(guideCardKey)).toEqual([
      "shoes",
      "qualify:blue",
      "lockers",
      "qualify:red",
      "night",
    ]);
  });

  it("leads with the shoe rule — the only one that sends somebody back to their car", () => {
    expect(guideCardsFor(BOTH)[0].kind).toBe("shoes");
  });

  it("never puts the two qualifying tables back to back", () => {
    const keys = guideCardsFor(BOTH).map(guideCardKey);
    const a = keys.indexOf("qualify:blue");
    const b = keys.indexOf("qualify:red");
    expect(Math.abs(a - b)).toBeGreaterThan(1);
  });

  it("drops to one qualifying card for a single-track screen", () => {
    expect(guideCardsFor(["blue"]).map(guideCardKey)).toEqual([
      "shoes",
      "qualify:blue",
      "lockers",
      "night",
    ]);
  });

  it("still has content with no tracks configured at all", () => {
    const cards = guideCardsFor([]);
    expect(cards.map(guideCardKey)).toEqual(["shoes", "lockers", "night"]);
  });

  it("handles a Mega day", () => {
    expect(guideCardsFor(["mega"]).map(guideCardKey)).toContain("qualify:mega");
  });
});

describe("guideCardAt", () => {
  const cards = guideCardsFor(BOTH);

  it("advances one card per interval and wraps the whole loop", () => {
    expect(guideCardKey(guideCardAt(0, cards))).toBe("shoes");
    expect(guideCardKey(guideCardAt(GUIDE_CARD_MS, cards))).toBe("qualify:blue");
    expect(guideCardKey(guideCardAt(GUIDE_CARD_MS * 4, cards))).toBe("night");
    expect(guideCardKey(guideCardAt(GUIDE_CARD_MS * 5, cards))).toBe("shoes");
  });

  it("holds the same card across its whole interval", () => {
    expect(guideCardKey(guideCardAt(GUIDE_CARD_MS + 1, cards))).toBe("qualify:blue");
    expect(guideCardKey(guideCardAt(GUIDE_CARD_MS * 2 - 1, cards))).toBe("qualify:blue");
  });

  it("two screens on the same clock show the same card", () => {
    const t = 1_700_000_123_456;
    expect(guideCardAt(t, cards)).toEqual(guideCardAt(t, cards));
  });

  it("still names a card on a nonsense clock, and on an empty list", () => {
    expect(guideCardAt(Number.NaN, cards)).toBeTruthy();
    expect(guideCardAt(-1, cards)).toBeTruthy();
    expect(guideCardAt(0, []).kind).toBe("shoes");
  });
});

describe("takeoverState", () => {
  const now = 1_700_000_000_000;

  it("is off when no send has happened", () => {
    expect(takeoverState({ briefedAtMs: null, nowMs: now })).toEqual({ on: false, remainingMs: 0 });
  });

  it("comes on the moment a heat is sent, and counts down", () => {
    expect(takeoverState({ briefedAtMs: now, nowMs: now }).remainingMs).toBe(GUIDE_TAKEOVER_MS);
    expect(takeoverState({ briefedAtMs: now - 30_000, nowMs: now }).remainingMs).toBe(
      GUIDE_TAKEOVER_MS - 30_000,
    );
  });

  it("drops out the instant the hold expires", () => {
    expect(takeoverState({ briefedAtMs: now - GUIDE_TAKEOVER_MS, nowMs: now }).on).toBe(false);
  });

  it("tolerates a send stamped a moment ahead — clock skew, not a bad send", () => {
    expect(takeoverState({ briefedAtMs: now + 3_000, nowMs: now }).on).toBe(true);
    expect(takeoverState({ briefedAtMs: now + 60_000, nowMs: now }).on).toBe(false);
  });

  it("a stale send from hours ago never puts an instruction on the wall", () => {
    expect(takeoverState({ briefedAtMs: now - 3 * 3600_000, nowMs: now }).on).toBe(false);
  });

  it("honours a per-screen hold", () => {
    expect(takeoverState({ briefedAtMs: now - 90_000, nowMs: now, holdMs: 60_000 }).on).toBe(false);
  });
});

describe("clampHoldMs", () => {
  it("defaults when unset or unusable", () => {
    expect(clampHoldMs(undefined)).toBe(GUIDE_TAKEOVER_MS);
    expect(clampHoldMs("120")).toBe(GUIDE_TAKEOVER_MS);
  });

  it("will not pin the wall all night, nor blink out before anyone turns around", () => {
    expect(clampHoldMs(60 * 60_000)).toBe(GUIDE_HOLD_MAX_MS);
    expect(clampHoldMs(0)).toBe(GUIDE_HOLD_MIN_MS);
  });

  it("passes a sensible value through", () => {
    expect(clampHoldMs(90_000)).toBe(90_000);
  });
});

describe("pickTakeover — one wall, two tracks", () => {
  const now = 1_700_000_000_000;
  const send = (track: "blue" | "red", agoMs: number | null): GuideSend => ({
    track,
    room: track,
    heatNumber: 59,
    raceType: `${track} Starter`,
    briefedAtMs: agoMs === null ? null : now - agoMs,
  });

  it("runs the cards when nothing is live", () => {
    const r = pickTakeover([send("blue", null), send("red", null)], now);
    expect(r.primary).toBeNull();
    expect(r.also).toEqual([]);
  });

  it("gives the wall to the only live send", () => {
    const r = pickTakeover([send("blue", 10_000), send("red", null)], now);
    expect(r.primary?.track).toBe("blue");
    expect(r.also).toHaveLength(0);
  });

  it("THE NEWEST SEND TAKES THE SCREEN — that group has not started walking yet", () => {
    const r = pickTakeover([send("blue", 90_000), send("red", 5_000)], now);
    expect(r.primary?.track).toBe("red");
  });

  it("does not drop the other group — it is named underneath", () => {
    const r = pickTakeover([send("blue", 90_000), send("red", 5_000)], now);
    expect(r.also.map((s) => s.track)).toEqual(["blue"]);
  });

  it("ignores an expired send even when it is the only one", () => {
    expect(pickTakeover([send("blue", GUIDE_TAKEOVER_MS + 1)], now).primary).toBeNull();
  });

  it("an expired send never appears underneath a live one", () => {
    const r = pickTakeover([send("blue", GUIDE_TAKEOVER_MS + 1), send("red", 1_000)], now);
    expect(r.primary?.track).toBe("red");
    expect(r.also).toEqual([]);
  });
});

describe("qualifyBoardFor", () => {
  it("gives Blue and Red their own adult cutoffs — the reason there are two cards", () => {
    expect(qualifyBoardFor("blue").adult).toEqual([
      { from: "Starter", to: "Intermediate", ms: 41_000 },
      { from: "Intermediate", to: "Pro", ms: 32_500 },
    ]);
    expect(qualifyBoardFor("red").adult).toEqual([
      { from: "Starter", to: "Intermediate", ms: 46_000 },
      { from: "Intermediate", to: "Pro", ms: 37_000 },
    ]);
  });

  it("Blue and Red never show the same times", () => {
    expect(qualifyBoardFor("blue").adult.map((r) => r.ms)).not.toEqual(
      qualifyBoardFor("red").adult.map((r) => r.ms),
    );
  });

  it("labels each card with the track its numbers belong to", () => {
    expect(qualifyBoardFor("blue").trackLabel).toBe("Blue Track");
    expect(qualifyBoardFor("red").trackLabel).toBe("Red Track");
  });

  it("uses Mega's own cutoffs on a Mega day", () => {
    expect(qualifyBoardFor("mega").adult).toEqual([
      { from: "Starter", to: "Intermediate", ms: 88_000 },
      { from: "Intermediate", to: "Pro", ms: 68_500 },
    ]);
  });

  it("carries the junior ladder, which is venue-wide rather than per track", () => {
    const junior = [
      { from: "Junior Starter", to: "Junior Intermediate", ms: 75_000 },
      { from: "Junior Intermediate", to: "Junior Pro", ms: 45_000 },
    ];
    expect(qualifyBoardFor("blue").junior).toEqual(junior);
    expect(qualifyBoardFor("red").junior).toEqual(junior);
  });

  it("always has exactly the two adult steps — the card is built for two rows", () => {
    for (const t of ["blue", "red", "mega"] as const) {
      expect(qualifyBoardFor(t).adult).toHaveLength(2);
    }
  });
});
