import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateRaceRestrictions,
  type RestrictionBlock,
  type RestrictionContext,
  type TrackTierBlock,
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

  it("allows JOINING an occupied Pro session even with an occupied Pro neighbor", () => {
    // Candidate 17:36 is itself occupied (a running session with seats) and
    // 17:24 next door is occupied too — joining adds heads, not sessions.
    const r = evaluateRaceRestrictions(
      backToBackCtx({
        candidateStartMs: ms(17, 36),
        productBlocks: [
          ...FULL_DAY_EMPTY.filter((b) => b.startMs !== ms(17, 36)),
          blk(17, 36, 6),
          blk(17, 24, 8),
        ],
      }),
    );
    expect(r.blocked).toBe(false);
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
    expect(r.ruleId).toBe("opening-heats-express-only");
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

  describe("Red + Mega — block first 2, third heat (:24) bookable", () => {
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

    it("uses ruleId opening-heats-express-only", () => {
      expect(mega(wd(13, 0)).ruleId).toBe("opening-heats-express-only");
      expect(red(wed(13, 0)).ruleId).toBe("opening-heats-express-only");
    });
  });

  describe("Blue (12-min cadence since 2026-07-02) — block first 2, third heat (:24) bookable", () => {
    const blue = (local: string) => at({ track: "Blue", candidateStartLocal: local });

    it("weekday: blocks 1:00 + 1:12, ALLOWS 1:24", () => {
      expect(blue(wd(13, 0)).blocked).toBe(true);
      expect(blue(wd(13, 12)).blocked).toBe(true);
      expect(blue(wd(13, 24)).blocked).toBe(false);
    });

    it("weekend: blocks 11:00 + 11:12, ALLOWS 11:24 (Sat & Sun)", () => {
      expect(blue(sat(11, 0)).blocked).toBe(true);
      expect(blue(sat(11, 12)).blocked).toBe(true);
      expect(blue(sat(11, 24)).blocked).toBe(false);
      expect(blue(sun(11, 12)).blocked).toBe(true);
      expect(blue(sun(11, 24)).blocked).toBe(false);
    });

    it("uses ruleId opening-heats-express-only", () => {
      expect(blue(wd(13, 0)).ruleId).toBe("opening-heats-express-only");
    });
  });

  // The window is anchored to the venue's open time FOR THE HEAT'S OWN DATE
  // (fasttrax-hours registry), not to "now" — so the 2026-08-10 Mon–Fri
  // 1 PM → 3 PM move applies from its effective date forward while heats before
  // it keep the old window. Both are correct at the same instant, which is the
  // whole point of gating on the heat rather than the clock.
  describe("follows the heat date's opening time across the 2026-08-10 late open", () => {
    // 2026-08-06 = Thu (1 PM era) · 2026-08-13 = Thu (3 PM era)
    const local = (date: string, h: number, m: number) =>
      `${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
    const heat = (date: string, h: number, m: number) =>
      evaluateRaceRestrictions(
        openingCtx({
          track: "Blue",
          candidateStartLocal: local(date, h, m),
          candidateStartMs: new Date(local(date, h, m)).getTime(),
        }),
      );

    it("a Thursday BEFORE the change still blocks 1:00 + 1:12 and allows 1:24", () => {
      expect(heat("2026-08-06", 13, 0).blocked).toBe(true);
      expect(heat("2026-08-06", 13, 12).blocked).toBe(true);
      expect(heat("2026-08-06", 13, 24).blocked).toBe(false);
      expect(heat("2026-08-06", 15, 0).blocked).toBe(false); // not open-adjacent yet
    });

    it("a Thursday AFTER the change blocks 3:00 + 3:12 and allows 3:24", () => {
      expect(heat("2026-08-13", 15, 0).blocked).toBe(true);
      expect(heat("2026-08-13", 15, 12).blocked).toBe(true);
      expect(heat("2026-08-13", 15, 24).blocked).toBe(false);
    });

    it("1:00 PM on a post-change weekday is no longer an opening heat (venue is shut)", () => {
      expect(heat("2026-08-13", 13, 0).blocked).toBe(false);
      expect(heat("2026-08-13", 13, 12).blocked).toBe(false);
    });

    it("Saturday keeps its 11:00 AM window on both sides of the change", () => {
      // 2026-08-08 = Sat (old era) · 2026-08-15 = Sat (new era)
      for (const sat of ["2026-08-08", "2026-08-15"]) {
        expect(heat(sat, 11, 0).blocked).toBe(true);
        expect(heat(sat, 11, 12).blocked).toBe(true);
        expect(heat(sat, 11, 24).blocked).toBe(false);
      }
    });
  });
});

describe("evaluateRaceRestrictions — Junior no back-to-back (Blue + Mega)", () => {
  // expressEligible + no candidateStartLocal → isolate from the opening-heats rule.
  function juniorCtx(over: Partial<RestrictionContext> = {}): RestrictionContext {
    return {
      tier: "intermediate",
      category: "junior",
      track: "Mega",
      candidateStartMs: ms(17, 36),
      nowMs: FAR_BEFORE,
      expressEligible: true,
      productBlocks: [],
      ...over,
    };
  }

  it("Mega: blocks a Junior slot adjacent (12 min) to an occupied Junior heat, action=hide", () => {
    const r = evaluateRaceRestrictions(
      juniorCtx({ candidateStartMs: ms(17, 36), productBlocks: [blk(17, 24, 8)] }),
    );
    expect(r.blocked).toBe(true);
    expect(r.ruleId).toBe("mega-no-back-to-back-junior");
    expect(r.action).toBe("hide");
  });

  it("Mega: allows the skip-one Junior slot (24 min away)", () => {
    const r = evaluateRaceRestrictions(
      juniorCtx({ candidateStartMs: ms(17, 48), productBlocks: [blk(17, 24, 8)] }),
    );
    expect(r.blocked).toBe(false);
  });

  it("Blue: blocks a Junior slot adjacent (12 min) to an occupied Junior heat", () => {
    const r = evaluateRaceRestrictions(
      juniorCtx({ track: "Blue", candidateStartMs: ms(17, 36), productBlocks: [blk(17, 24, 8)] }),
    );
    expect(r.blocked).toBe(true);
    expect(r.ruleId).toBe("blue-no-back-to-back-junior");
  });

  it("Blue: allows the skip-one Junior slot (24 min away)", () => {
    const r = evaluateRaceRestrictions(
      juniorCtx({ track: "Blue", candidateStartMs: ms(17, 48), productBlocks: [blk(17, 24, 8)] }),
    );
    expect(r.blocked).toBe(false);
  });

  it("allows when the neighbor slot is empty", () => {
    const r = evaluateRaceRestrictions(
      juniorCtx({ candidateStartMs: ms(17, 36), productBlocks: [blk(17, 24, 10)] }),
    );
    expect(r.blocked).toBe(false);
  });

  it("does NOT lift within 60 min — junior back-to-back is unconditional", () => {
    const candidate = ms(17, 36);
    const r = evaluateRaceRestrictions(
      juniorCtx({
        candidateStartMs: candidate,
        nowMs: candidate - 45 * 60_000,
        productBlocks: [blk(17, 24, 8)],
      }),
    );
    expect(r.blocked).toBe(true);
  });

  it("counts OTHER junior tiers' occupied neighbors (scope=category via categoryTrackBlocks)", () => {
    // Candidate is junior intermediate; the occupied neighbor exists only in the
    // junior PRO union — invisible in productBlocks, visible in categoryTrackBlocks.
    const r = evaluateRaceRestrictions(
      juniorCtx({
        candidateStartMs: ms(17, 36),
        productBlocks: [],
        categoryTrackBlocks: [blk(17, 24, 8)],
      }),
    );
    expect(r.blocked).toBe(true);
    expect(r.ruleId).toBe("mega-no-back-to-back-junior");
  });

  it("falls back to productBlocks when categoryTrackBlocks is absent/empty", () => {
    const r = evaluateRaceRestrictions(
      juniorCtx({
        candidateStartMs: ms(17, 36),
        productBlocks: [blk(17, 24, 8)],
        categoryTrackBlocks: [],
      }),
    );
    expect(r.blocked).toBe(true);
  });

  it("does NOT apply to adult parties (category-scoped)", () => {
    // Adult intermediate Mega has no back-to-back rule (only Pro does for adults).
    const r = evaluateRaceRestrictions(
      juniorCtx({ category: "adult", productBlocks: [blk(17, 24, 8)] }),
    );
    expect(r.blocked).toBe(false);
  });

  it("allows JOINING an occupied Junior session next to another occupied Junior (owner 2026-07-14)", () => {
    // The live 7/15 case: 13:36 junior starter has open seats, 13:24 next door
    // is junior-occupied. Joining 13:36 adds heads, not a new session pair.
    const r = evaluateRaceRestrictions(
      juniorCtx({
        track: "Blue",
        candidateStartMs: ms(13, 36),
        productBlocks: [blk(13, 36, 5, 7), blk(13, 24, 4, 7)],
        categoryTrackBlocks: [blk(13, 36, 5, 7), blk(13, 24, 4, 7)],
      }),
    );
    expect(r.blocked).toBe(false);
  });

  it("join exemption requires OWN-TIER occupancy — cross-tier-only occupancy doesn't count", () => {
    // Candidate slot occupied only in the category union (another junior tier's
    // session), empty in the candidate's own productBlocks → still blocked.
    // (In production such a slot never appears as a candidate — occupied heats
    // are tier-exclusive — but the evaluator must not treat union occupancy as
    // a joinable session.)
    const r = evaluateRaceRestrictions(
      juniorCtx({
        track: "Blue",
        candidateStartMs: ms(13, 36),
        productBlocks: [blk(13, 36, 7, 7)],
        categoryTrackBlocks: [blk(13, 36, 4, 7), blk(13, 24, 4, 7)],
      }),
    );
    expect(r.blocked).toBe(true);
    expect(r.ruleId).toBe("blue-no-back-to-back-junior");
  });

  it("a FULL own slot (freeSpots 0) still counts as joining — capacity is the caller's gate", () => {
    const r = evaluateRaceRestrictions(
      juniorCtx({
        track: "Blue",
        candidateStartMs: ms(13, 36),
        productBlocks: [blk(13, 36, 0, 7), blk(13, 24, 4, 7)],
      }),
    );
    expect(r.blocked).toBe(false);
  });

  it("an EMPTY candidate slot next to an occupied Junior still blocks (regression)", () => {
    const r = evaluateRaceRestrictions(
      juniorCtx({
        track: "Blue",
        candidateStartMs: ms(13, 12),
        productBlocks: [blk(13, 12, 7, 7), blk(13, 24, 4, 7)],
      }),
    );
    expect(r.blocked).toBe(true);
    expect(r.ruleId).toBe("blue-no-back-to-back-junior");
  });
});

describe("evaluateRaceRestrictions — Mega two Junior races per clock hour", () => {
  // Naive wall-clock starts on a known weekday (Tue 2026-06-23). 13:36+ is past
  // the weekday opening window, so the opening-heats rule never interferes.
  const wd = (h: number, m: number) =>
    `2026-06-23T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;

  function hourCtx(over: Partial<RestrictionContext> = {}): RestrictionContext {
    return {
      tier: "intermediate",
      category: "junior",
      track: "Mega",
      candidateStartMs: ms(13, 36),
      candidateStartLocal: wd(13, 36),
      nowMs: FAR_BEFORE,
      expressEligible: true,
      productBlocks: [], // isolate from the back-to-back rule
      categoryTrackBlocks: [],
      ...over,
    };
  }

  it("blocks a 3rd Junior heat when two are already occupied in the same clock hour, action=hide", () => {
    const r = evaluateRaceRestrictions(
      hourCtx({ categoryTrackBlocks: [blk(13, 0, 8), blk(13, 12, 8)] }),
    );
    expect(r.blocked).toBe(true);
    expect(r.ruleId).toBe("mega-junior-two-per-hour");
    expect(r.action).toBe("hide");
  });

  it("allows when only one Junior heat is occupied in the hour", () => {
    expect(
      evaluateRaceRestrictions(hourCtx({ categoryTrackBlocks: [blk(13, 0, 8)] })).blocked,
    ).toBe(false);
  });

  it("counts across tiers — two occupied heats in the hour block regardless of type", () => {
    // categoryTrackBlocks is the union of junior intermediate + junior pro Mega.
    const r = evaluateRaceRestrictions(
      hourCtx({ tier: "pro", categoryTrackBlocks: [blk(13, 0, 8), blk(13, 24, 8)] }),
    );
    expect(r.blocked).toBe(true);
  });

  it("only counts heats in the candidate's clock hour", () => {
    // Occupied at 12:48 (prior hour) + 14:00 (next hour) — neither in the 13:00 hour.
    const r = evaluateRaceRestrictions(
      hourCtx({ categoryTrackBlocks: [blk(12, 48, 8), blk(14, 0, 8)] }),
    );
    expect(r.blocked).toBe(false);
  });

  it("dedupes the same start time across tiers (counts once)", () => {
    // Same slot present in both tiers' responses + one other → 2 distinct → block.
    const r = evaluateRaceRestrictions(
      hourCtx({ categoryTrackBlocks: [blk(13, 0, 8), blk(13, 0, 8), blk(13, 12, 8)] }),
    );
    expect(r.blocked).toBe(true);
    // Same slot twice but no second distinct slot → 1 distinct → allow.
    expect(
      evaluateRaceRestrictions(hourCtx({ categoryTrackBlocks: [blk(13, 0, 8), blk(13, 0, 8)] }))
        .blocked,
    ).toBe(false);
  });

  it("ignores empty heats and the candidate's own slot", () => {
    const r = evaluateRaceRestrictions(
      hourCtx({
        candidateStartMs: ms(13, 36),
        categoryTrackBlocks: [blk(13, 36, 8), blk(13, 0, 10), blk(13, 12, 8)],
      }),
    );
    // candidate's own (13:36) excluded, 13:00 empty excluded → only 13:12 → allow.
    expect(r.blocked).toBe(false);
  });

  it("no-ops when categoryTrackBlocks is absent", () => {
    const r = evaluateRaceRestrictions(hourCtx({ categoryTrackBlocks: undefined }));
    expect(r.blocked).toBe(false);
  });

  it("does not apply on Blue (per-hour cap is Mega-only)", () => {
    const r = evaluateRaceRestrictions(
      hourCtx({ track: "Blue", categoryTrackBlocks: [blk(13, 0, 8), blk(13, 15, 8)] }),
    );
    expect(r.blocked).toBe(false);
  });
});

describe("evaluateRaceRestrictions — reserve room for two adult Starter races per hour", () => {
  // Naive wall-clock starts on a known weekday (Tue 2026-06-23), mid-afternoon
  // so the opening-heats rule never interferes. All tracks run the 12-min
  // cadence = 5 heats/hour (:00 :12 :24 :36 :48; Blue included since 2026-07-02).
  const wd = (h: number, m: number) =>
    `2026-06-23T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
  const tblk = (
    h: number,
    m: number,
    freeSpots: number,
    adultStarter = false,
    capacity = 10,
  ): TrackTierBlock => ({ ...blk(h, m, freeSpots, capacity), adultStarter });

  function roomCtx(over: Partial<RestrictionContext> = {}): RestrictionContext {
    return {
      tier: "intermediate",
      category: "adult",
      track: "Mega",
      candidateStartMs: ms(15, 36),
      candidateStartLocal: wd(15, 36),
      nowMs: FAR_BEFORE,
      expressEligible: true,
      productBlocks: [], // isolate from the back-to-back rules
      trackAllTierBlocks: [],
      ...over,
    };
  }

  it("blocks a non-Starter pick that would leave under 2 slots for adult Starter, action=hide", () => {
    // Hour 15: 3 occupied non-Starter + candidate (15:36) + one free (15:48)
    // → booking would leave room = 1.
    const r = evaluateRaceRestrictions(
      roomCtx({
        trackAllTierBlocks: [
          tblk(15, 0, 8),
          tblk(15, 12, 8),
          tblk(15, 24, 8),
          tblk(15, 36, 10),
          tblk(15, 48, 10),
        ],
      }),
    );
    expect(r.blocked).toBe(true);
    expect(r.ruleId).toBe("starter-room-per-hour");
    expect(r.action).toBe("hide");
  });

  it("allows when 2 slots would remain free after booking", () => {
    const r = evaluateRaceRestrictions(
      roomCtx({
        trackAllTierBlocks: [
          tblk(15, 0, 8),
          tblk(15, 12, 8),
          tblk(15, 24, 10),
          tblk(15, 36, 10),
          tblk(15, 48, 10),
        ],
      }),
    );
    expect(r.blocked).toBe(false);
  });

  it("counts an occupied adult-Starter session as room (booked Starter races satisfy the guarantee)", () => {
    // 15:00 is an ACTIVE adult Starter race; 15:12 + 15:24 occupied non-Starter;
    // 15:48 free. Room after booking 15:36 = Starter session + one free = 2.
    const r = evaluateRaceRestrictions(
      roomCtx({
        trackAllTierBlocks: [
          tblk(15, 0, 8, true),
          tblk(15, 12, 8),
          tblk(15, 24, 8),
          tblk(15, 36, 10),
          tblk(15, 48, 10),
        ],
      }),
    );
    expect(r.blocked).toBe(false);
  });

  it("joining an already-occupied same-tier heat consumes no new room — allowed even under quota", () => {
    // Candidate 15:36 is itself an active session (occupied). The hour is
    // ALREADY under the 2-slot guarantee (3 occupied non-Starter, 1 free), but
    // adding a racer to a running race takes nothing from Starters → allowed.
    const r = evaluateRaceRestrictions(
      roomCtx({
        trackAllTierBlocks: [
          tblk(15, 0, 8),
          tblk(15, 12, 8),
          tblk(15, 24, 8),
          tblk(15, 36, 8),
          tblk(15, 48, 10),
        ],
      }),
    );
    expect(r.blocked).toBe(false);
  });

  it("dedupes a free slot present in several products' responses (counts once)", () => {
    // 15:48 free appears in 3 tiers' availability; 3 occupied non-Starter →
    // room = 1 (not 3) → block.
    const r = evaluateRaceRestrictions(
      roomCtx({
        trackAllTierBlocks: [
          tblk(15, 0, 8),
          tblk(15, 12, 8),
          tblk(15, 24, 8),
          tblk(15, 48, 10),
          tblk(15, 48, 10),
          tblk(15, 48, 10),
        ],
      }),
    );
    expect(r.blocked).toBe(true);
  });

  it("only counts the candidate's clock hour", () => {
    // Everything occupied in hour 14 — hour 15 is wide open.
    const r = evaluateRaceRestrictions(
      roomCtx({
        trackAllTierBlocks: [
          tblk(14, 0, 8),
          tblk(14, 12, 8),
          tblk(14, 24, 8),
          tblk(14, 36, 8),
          tblk(14, 48, 8),
          tblk(15, 24, 10),
          tblk(15, 48, 10),
        ],
      }),
    );
    expect(r.blocked).toBe(false);
  });

  it("lifts the block when the candidate starts within 60 min of now (fill unused reserved slots)", () => {
    const candidate = ms(15, 36);
    const r = evaluateRaceRestrictions(
      roomCtx({
        nowMs: candidate - 45 * 60_000,
        trackAllTierBlocks: [tblk(15, 0, 8), tblk(15, 12, 8), tblk(15, 24, 8), tblk(15, 48, 10)],
      }),
    );
    expect(r.blocked).toBe(false);
  });

  it("applies to Pro and on Red/Blue too", () => {
    const proRed = evaluateRaceRestrictions(
      roomCtx({
        tier: "pro",
        track: "Red",
        trackAllTierBlocks: [tblk(15, 0, 8), tblk(15, 12, 8), tblk(15, 24, 8), tblk(15, 48, 10)],
      }),
    );
    expect(proRed.blocked).toBe(true);
    // Blue: 2 occupied non-Starter + candidate 15:36 + free 15:48 → room = 1 → block.
    const intBlue = evaluateRaceRestrictions(
      roomCtx({
        track: "Blue",
        candidateStartMs: ms(15, 36),
        candidateStartLocal: wd(15, 36),
        trackAllTierBlocks: [tblk(15, 0, 8), tblk(15, 12, 8), tblk(15, 48, 10)],
      }),
    );
    expect(intBlue.blocked).toBe(true);
  });

  it("guards junior Starter on Blue (reserved slots are for ADULT Starter only)", () => {
    const r = evaluateRaceRestrictions(
      roomCtx({
        tier: "starter",
        category: "junior",
        track: "Blue",
        candidateStartMs: ms(15, 36),
        candidateStartLocal: wd(15, 36),
        trackAllTierBlocks: [tblk(15, 0, 8), tblk(15, 12, 8), tblk(15, 48, 10)],
      }),
    );
    expect(r.blocked).toBe(true);
    expect(r.ruleId).toBe("starter-room-per-hour-junior-starter");
  });

  it("never blocks an ADULT Starter pick", () => {
    const r = evaluateRaceRestrictions(
      roomCtx({
        tier: "starter",
        category: "adult",
        trackAllTierBlocks: [tblk(15, 0, 8), tblk(15, 12, 8), tblk(15, 24, 8), tblk(15, 48, 8)],
      }),
    );
    expect(r.blocked).toBe(false);
  });

  it("no-ops when trackAllTierBlocks or candidateStartLocal is absent", () => {
    const occupiedHour = [tblk(15, 0, 8), tblk(15, 12, 8), tblk(15, 24, 8), tblk(15, 48, 10)];
    expect(evaluateRaceRestrictions(roomCtx({ trackAllTierBlocks: undefined })).blocked).toBe(
      false,
    );
    expect(
      evaluateRaceRestrictions(
        roomCtx({ candidateStartLocal: undefined, trackAllTierBlocks: occupiedHour }),
      ).blocked,
    ).toBe(false);
  });
});

describe("evaluateRaceRestrictions — VIP combo anchor reserve", () => {
  // Flag defaults ON (owner 2026-07-06) — these tests run against the real
  // default. The rule's `enabled` is a getter reading the env per evaluation,
  // so the kill-switch test stubs "false" without a module reload.
  afterEach(() => vi.unstubAllEnvs());

  // Naive wall-clock starts on Tue 2026-06-23, mid-afternoon — clear of the
  // opening-heats window. Since 2026-08-10 the grid is HOURLY and day-aware
  // (weekday 3–10 PM — no 2 PM; weekend 2–10 PM) and adult STARTER bookings
  // are exempt (owner: a Starter session at the anchor time is what the VIP
  // party joins, so it preserves the anchor; other tiers consume it).
  const wd = (h: number, m: number) =>
    `2026-06-23T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
  const sat = (h: number, m: number) =>
    `2026-06-27T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;

  // Default context is an INTERMEDIATE pick at a weekday anchor (6 PM) —
  // the shape the reserve still blocks.
  function vipCtx(over: Partial<RestrictionContext> = {}): RestrictionContext {
    return {
      tier: "intermediate",
      category: "adult",
      track: "Red",
      candidateStartMs: ms(18, 0),
      candidateStartLocal: wd(18, 0),
      nowMs: FAR_BEFORE,
      expressEligible: true,
      productBlocks: [blk(18, 0, 10)], // the candidate's own slot, still empty
      ...over,
    };
  }

  it("blocks a still-empty anchor slot for non-Starter tiers, action=disable + 'VIP Reserved'", () => {
    const r = evaluateRaceRestrictions(vipCtx());
    expect(r.blocked).toBe(true);
    expect(r.ruleId).toBe("vip-combo-anchor-reserve");
    expect(r.action).toBe("disable");
    expect(r.cardLabel).toBe("VIP Reserved");
  });

  it("adult STARTER may take the empty anchor slot (owner 2026-08-10 — it creates the joinable anchor)", () => {
    expect(evaluateRaceRestrictions(vipCtx({ tier: "starter" })).blocked).toBe(false);
    // absent category defaults to adult — some callers omit it
    expect(evaluateRaceRestrictions(vipCtx({ tier: "starter", category: null })).blocked).toBe(
      false,
    );
  });

  it("junior sessions still consume the anchor — junior Starter stays blocked", () => {
    const jr = evaluateRaceRestrictions(
      vipCtx({
        tier: "starter",
        category: "junior",
        track: "Blue",
        candidateStartMs: ms(18, 0),
        candidateStartLocal: wd(18, 0),
        productBlocks: [blk(18, 0, 10)],
      }),
    );
    expect(jr.blocked).toBe(true);
    expect(jr.ruleId).toBe("vip-combo-anchor-reserve");
  });

  it("kiosk surface HIDES the anchor hold instead of greying it (owner 2026-07-19)", () => {
    const r = evaluateRaceRestrictions(vipCtx({ kiosk: true }));
    expect(r.blocked).toBe(true); // blocking identical — presentation only
    expect(r.ruleId).toBe("vip-combo-anchor-reserve");
    expect(r.action).toBe("hide");
    expect(r.cardLabel).toBeUndefined();
    // Rules WITHOUT a kioskPresentation keep their web presentation on kiosk.
    const opening = evaluateRaceRestrictions(
      vipCtx({
        kiosk: true,
        expressEligible: false,
        candidateStartMs: ms(13, 12),
        candidateStartLocal: wd(13, 12), // Tue opening window 1:00–1:24 PM
        productBlocks: [blk(13, 12, 10)],
      }),
    );
    expect(opening.ruleId).toBe("opening-heats-express-only");
    expect(opening.action).toBe("disable");
  });

  it("day-aware grid: hourly anchors weekdays 3–10 PM; 2 PM is weekend-only", () => {
    // 7 PM weekday (an odd hour the old 2/4/6/8/10 grid never held) — blocked.
    expect(
      evaluateRaceRestrictions(
        vipCtx({
          candidateStartMs: ms(19, 0),
          candidateStartLocal: wd(19, 0),
          productBlocks: [blk(19, 0, 10)],
        }),
      ).blocked,
    ).toBe(true);
    // 10 PM weekday — still covered.
    expect(
      evaluateRaceRestrictions(
        vipCtx({
          candidateStartMs: ms(22, 0),
          candidateStartLocal: wd(22, 0),
          productBlocks: [blk(22, 0, 10)],
        }),
      ).blocked,
    ).toBe(true);
    // 2 PM on a WEEKDAY is not an anchor (FT opens at 3 Mon–Fri) — allowed.
    expect(
      evaluateRaceRestrictions(
        vipCtx({
          candidateStartMs: ms(14, 0),
          candidateStartLocal: wd(14, 0),
          productBlocks: [blk(14, 0, 10)],
        }),
      ).blocked,
    ).toBe(false);
    // 2 PM on a SATURDAY is an anchor (weekend grid) — blocked.
    expect(
      evaluateRaceRestrictions(
        vipCtx({
          candidateStartMs: ms(14, 0),
          candidateStartLocal: sat(14, 0),
          productBlocks: [blk(14, 0, 10)],
        }),
      ).blocked,
    ).toBe(true);
  });

  it("allows non-anchor minutes", () => {
    expect(
      evaluateRaceRestrictions(
        vipCtx({
          candidateStartMs: ms(18, 12),
          candidateStartLocal: wd(18, 12),
          productBlocks: [blk(18, 12, 10)],
        }),
      ).blocked,
    ).toBe(false);
  });

  it("allows joining an already-occupied same-tier session at the anchor time", () => {
    const r = evaluateRaceRestrictions(vipCtx({ productBlocks: [blk(18, 0, 6)] }));
    expect(r.blocked).toBe(false);
  });

  it("lifts within 60 min of the heat (unclaimed anchors still fill)", () => {
    const candidate = ms(18, 0);
    expect(evaluateRaceRestrictions(vipCtx({ nowMs: candidate - 45 * 60_000 })).blocked).toBe(
      false,
    );
    expect(evaluateRaceRestrictions(vipCtx({ nowMs: candidate - 61 * 60_000 })).blocked).toBe(true);
  });

  it("exempts combo bookings from this rule only", () => {
    // The combo's own anchor booking sails through…
    expect(evaluateRaceRestrictions(vipCtx({ isComboBooking: true })).blocked).toBe(false);
    // …but a combo junior heat still hits the junior back-to-back rule.
    const r = evaluateRaceRestrictions(
      vipCtx({
        isComboBooking: true,
        tier: "intermediate",
        category: "junior",
        track: "Blue",
        candidateStartMs: ms(17, 36),
        candidateStartLocal: wd(17, 36),
        productBlocks: [blk(17, 24, 8)], // occupied junior neighbor 12 min away
      }),
    );
    expect(r.blocked).toBe(true);
    expect(r.ruleId).toBe("blue-no-back-to-back-junior");
  });

  it("no-ops without candidateStartLocal (epoch-only caller)", () => {
    expect(evaluateRaceRestrictions(vipCtx({ candidateStartLocal: undefined })).blocked).toBe(
      false,
    );
  });

  it("kill switch: explicitly setting the flag to false disables the rule", () => {
    vi.stubEnv("NEXT_PUBLIC_COMBO_VIP_ANCHOR_RESERVE", "false");
    expect(evaluateRaceRestrictions(vipCtx()).blocked).toBe(false);
  });
});
