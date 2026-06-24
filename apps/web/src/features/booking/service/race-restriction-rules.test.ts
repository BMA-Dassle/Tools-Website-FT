import { describe, expect, it } from "vitest";
import {
  evaluateRaceRestrictions,
  type RestrictionBlock,
  type RestrictionContext,
} from "./race-restriction-rules";

// Heat clock helpers — Mega Tuesday 12-min cadence.
const ms = (h: number, m: number) =>
  new Date(`2026-06-23T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`).getTime();
const blk = (h: number, m: number, freeSpots: number, capacity = 10): RestrictionBlock => ({
  startMs: ms(h, m),
  freeSpots,
  capacity,
});

// A "now" far before the race day so the last-minute override never trips
// unless a test explicitly sets it.
const FAR_BEFORE = ms(23, 59) - 23 * 60 * 60_000; // ~previous day

// A full day of empty Mega heats so the candidate never ranks in the first 3
// (isolates the back-to-back rule from the opening-heats rule).
const FULL_DAY_EMPTY: RestrictionBlock[] = Array.from({ length: 20 }, (_, i) =>
  blk(13, i * 12, 10),
);

function backToBackCtx(over: Partial<RestrictionContext> = {}): RestrictionContext {
  return {
    tier: "pro",
    track: "Mega",
    candidateStartMs: ms(17, 36),
    nowMs: FAR_BEFORE,
    expressEligible: true, // isolate from opening-heats rule
    productBlocks: [],
    ...over,
  };
}

describe("evaluateRaceRestrictions — Mega no back-to-back Pro", () => {
  it("blocks a Pro slot adjacent (12 min) to an occupied Pro heat, action=hide", () => {
    const r = evaluateRaceRestrictions(
      backToBackCtx({
        candidateStartMs: ms(17, 36),
        productBlocks: [...FULL_DAY_EMPTY, blk(17, 24, 8)],
      }),
    );
    expect(r.blocked).toBe(true);
    expect(r.ruleId).toBe("mega-no-back-to-back-pro");
    expect(r.action).toBe("hide");
  });

  it("blocks when the occupied Pro neighbor is on the other side", () => {
    const r = evaluateRaceRestrictions(
      backToBackCtx({ candidateStartMs: ms(17, 36), productBlocks: [blk(17, 48, 9)] }),
    );
    expect(r.blocked).toBe(true);
  });

  it("allows when the neighbor slot is empty (freeSpots === capacity)", () => {
    const r = evaluateRaceRestrictions(
      backToBackCtx({ candidateStartMs: ms(17, 36), productBlocks: [blk(17, 24, 10)] }),
    );
    expect(r.blocked).toBe(false);
  });

  it("allows the skip-one slot (24 min away) next to an occupied Pro heat", () => {
    const r = evaluateRaceRestrictions(
      backToBackCtx({ candidateStartMs: ms(17, 48), productBlocks: [blk(17, 24, 8)] }),
    );
    expect(r.blocked).toBe(false); // 24 min >= 13-min threshold
  });

  it("does not count the candidate's own occupied slot as a neighbor", () => {
    const r = evaluateRaceRestrictions(
      backToBackCtx({ candidateStartMs: ms(17, 24), productBlocks: [blk(17, 24, 8)] }),
    );
    expect(r.blocked).toBe(false);
  });

  it("lifts the block when the candidate starts within 60 min of now", () => {
    const candidate = ms(17, 36);
    const r = evaluateRaceRestrictions(
      backToBackCtx({
        candidateStartMs: candidate,
        nowMs: candidate - 45 * 60_000,
        productBlocks: [blk(17, 24, 8)],
      }),
    );
    expect(r.blocked).toBe(false);
  });

  it("still blocks when the candidate is just outside the 60-min window", () => {
    const candidate = ms(17, 36);
    const r = evaluateRaceRestrictions(
      backToBackCtx({
        candidateStartMs: candidate,
        nowMs: candidate - 61 * 60_000,
        productBlocks: [blk(17, 24, 8)],
      }),
    );
    expect(r.blocked).toBe(true);
  });

  it("ignores non-Pro tiers for the back-to-back rule", () => {
    // starter + express → neither rule fires
    const r = evaluateRaceRestrictions(
      backToBackCtx({ tier: "starter", productBlocks: [...FULL_DAY_EMPTY, blk(17, 24, 8)] }),
    );
    expect(r.blocked).toBe(false);
  });

  it("ignores non-Mega tracks", () => {
    const r = evaluateRaceRestrictions(
      backToBackCtx({ track: "Red", productBlocks: [blk(17, 24, 8)] }),
    );
    expect(r.blocked).toBe(false);
  });
});

describe("evaluateRaceRestrictions — opening heats walk-in / express only", () => {
  // Naive wall-clock start strings (no TZ) on known days:
  //   2026-06-23 = Tue, 2026-06-24 = Wed (weekday, 1:00 PM open)
  //   2026-06-27 = Sat, 2026-06-28 = Sun (weekend, 11:00 AM open)
  const wd = (h: number, m: number) =>
    `2026-06-23T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`; // Tue
  const wed = (h: number, m: number) =>
    `2026-06-24T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`; // Wed
  const sat = (h: number, m: number) =>
    `2026-06-27T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
  const sun = (h: number, m: number) =>
    `2026-06-28T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;

  function openingCtx(over: Partial<RestrictionContext> = {}): RestrictionContext {
    return {
      tier: "starter",
      track: "Mega",
      candidateStartMs: ms(13, 12),
      candidateStartLocal: wd(13, 12), // 2nd weekday heat (1:12 PM) → blocked on a 12-min track
      nowMs: FAR_BEFORE,
      expressEligible: false,
      productBlocks: [],
      ...over,
    };
  }
  const at = (over: Partial<RestrictionContext>) => evaluateRaceRestrictions(openingCtx(over));

  it("disables an opening heat for a non-express party, action=disable + 'Walk-In or Express Only'", () => {
    const r = evaluateRaceRestrictions(openingCtx());
    expect(r.blocked).toBe(true);
    expect(r.action).toBe("disable");
    expect(r.cardLabel).toBe("Walk-In or Express Only");
    expect(r.ruleId).toBe("opening-heats-express-only-12min");
  });

  it("allows an opening heat for an express-eligible party", () => {
    expect(at({ expressEligible: true }).blocked).toBe(false);
  });

  it("does not block when candidateStartLocal is absent (epoch-only callers)", () => {
    expect(at({ candidateStartLocal: undefined }).blocked).toBe(false);
  });

  it("ignores tracks that are not race tracks", () => {
    expect(at({ track: "Putt" }).blocked).toBe(false);
  });

  it("matches track names case-insensitively", () => {
    expect(at({ track: "mega", candidateStartLocal: wd(13, 0) }).blocked).toBe(true);
    expect(at({ track: "blue", candidateStartLocal: wd(13, 0) }).blocked).toBe(true);
  });

  it("applies to every tier (not just one)", () => {
    expect(at({ tier: "pro" }).blocked).toBe(true);
    expect(at({ tier: "intermediate" }).blocked).toBe(true);
  });

  it("does NOT slide: a mid-afternoon heat is allowed even when it is the earliest in availability", () => {
    // The day's opening heats have passed/sold out; availability now starts at
    // 3:00 PM. Rank-based logic would have flagged these as the opening heats;
    // the clock window must not.
    expect(
      at({
        candidateStartLocal: wd(15, 0),
        candidateStartMs: ms(15, 0),
        productBlocks: [blk(15, 0, 10), blk(15, 12, 10), blk(15, 24, 10)],
      }).blocked,
    ).toBe(false);
  });

  describe("12-min tracks (Red, Mega) — block first 2, third heat (:24) bookable", () => {
    const mega = (local: string) => at({ track: "Mega", candidateStartLocal: local });
    const red = (local: string) => at({ track: "Red", candidateStartLocal: local });

    it("Mega weekday: blocks 1:00 + 1:12, ALLOWS 1:24", () => {
      expect(mega(wd(13, 0)).blocked).toBe(true);
      expect(mega(wd(13, 12)).blocked).toBe(true);
      expect(mega(wd(13, 24)).blocked).toBe(false);
      expect(mega(wd(13, 24)).ruleId).toBeUndefined();
    });

    it("Red weekday: blocks 1:00 + 1:12, ALLOWS 1:24", () => {
      expect(red(wed(13, 0)).blocked).toBe(true);
      expect(red(wed(13, 12)).blocked).toBe(true);
      expect(red(wed(13, 24)).blocked).toBe(false);
    });

    it("Red weekend: blocks 11:00 + 11:12, ALLOWS 11:24 (Sat & Sun)", () => {
      expect(red(sat(11, 0)).blocked).toBe(true);
      expect(red(sat(11, 12)).blocked).toBe(true);
      expect(red(sat(11, 24)).blocked).toBe(false);
      expect(red(sun(11, 12)).blocked).toBe(true);
      expect(red(sun(11, 24)).blocked).toBe(false);
    });

    it("allows heats before open and after the window", () => {
      expect(mega(wd(12, 48)).blocked).toBe(false); // before 1:00 open
      expect(mega(wd(13, 36)).blocked).toBe(false); // well past the window
    });

    it("uses ruleId opening-heats-express-only-12min", () => {
      expect(mega(wd(13, 0)).ruleId).toBe("opening-heats-express-only-12min");
      expect(red(wed(13, 0)).ruleId).toBe("opening-heats-express-only-12min");
    });
  });

  describe("15-min track (Blue) — block first 2, third heat (:30) bookable", () => {
    const blue = (local: string) => at({ track: "Blue", candidateStartLocal: local });

    it("weekday: blocks 1:00 + 1:15, ALLOWS 1:30", () => {
      expect(blue(wd(13, 0)).blocked).toBe(true);
      expect(blue(wd(13, 15)).blocked).toBe(true);
      expect(blue(wd(13, 30)).blocked).toBe(false);
    });

    it("weekend: blocks 11:00 + 11:15, ALLOWS 11:30 (Sat & Sun)", () => {
      expect(blue(sat(11, 0)).blocked).toBe(true);
      expect(blue(sat(11, 15)).blocked).toBe(true);
      expect(blue(sat(11, 30)).blocked).toBe(false);
      expect(blue(sun(11, 15)).blocked).toBe(true);
      expect(blue(sun(11, 30)).blocked).toBe(false);
    });

    it("uses ruleId opening-heats-express-only-15min", () => {
      expect(blue(wd(13, 0)).ruleId).toBe("opening-heats-express-only-15min");
    });
  });
});
