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

describe("evaluateRaceRestrictions — Mega opening heats express-only", () => {
  // Naive wall-clock start strings (no TZ) on known weekdays:
  //   2026-06-23 = Tuesday (weekday, 1:00 PM open)
  //   2026-06-27 = Saturday, 2026-06-28 = Sunday (weekend, 11:00 AM open)
  const wd = (h: number, m: number) =>
    `2026-06-23T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
  const sat = (h: number, m: number) =>
    `2026-06-27T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
  const sun = (h: number, m: number) =>
    `2026-06-28T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;

  function openingCtx(over: Partial<RestrictionContext> = {}): RestrictionContext {
    return {
      tier: "starter",
      track: "Mega",
      candidateStartMs: ms(13, 24),
      candidateStartLocal: wd(13, 24), // 3rd weekday heat (1:24 PM) → in the 1:00–1:30 window
      nowMs: FAR_BEFORE,
      expressEligible: false,
      productBlocks: [],
      ...over,
    };
  }

  it("hides a weekday opening-window heat for a non-express party, action=hide", () => {
    const r = evaluateRaceRestrictions(openingCtx());
    expect(r.blocked).toBe(true);
    expect(r.ruleId).toBe("mega-opening-heats-express-only");
    expect(r.action).toBe("hide");
  });

  it("allows an opening-window heat for an express-eligible party", () => {
    const r = evaluateRaceRestrictions(openingCtx({ expressEligible: true }));
    expect(r.blocked).toBe(false);
  });

  it("blocks the very first weekday heat (1:00 PM) for a non-express party", () => {
    const r = evaluateRaceRestrictions(openingCtx({ candidateStartLocal: wd(13, 0) }));
    expect(r.blocked).toBe(true);
  });

  it("allows the 1:36 PM heat (just past the 1:30 weekday window)", () => {
    const r = evaluateRaceRestrictions(openingCtx({ candidateStartLocal: wd(13, 36) }));
    expect(r.blocked).toBe(false);
  });

  it("allows a heat before the 1:00 PM weekday open", () => {
    const r = evaluateRaceRestrictions(openingCtx({ candidateStartLocal: wd(12, 48) }));
    expect(r.blocked).toBe(false);
  });

  it("does NOT slide: a mid-afternoon heat is allowed even when it is the earliest in availability", () => {
    // The day's opening heats have passed/sold out; availability now starts at
    // 3:00 PM. Rank-based logic would have flagged these as the 'first 3'; the
    // clock window must not.
    const r = evaluateRaceRestrictions(
      openingCtx({
        candidateStartLocal: wd(15, 0),
        candidateStartMs: ms(15, 0),
        productBlocks: [blk(15, 0, 10), blk(15, 12, 10), blk(15, 24, 10)],
      }),
    );
    expect(r.blocked).toBe(false);
  });

  it("uses the 11:00–11:30 AM window on Saturday", () => {
    expect(evaluateRaceRestrictions(openingCtx({ candidateStartLocal: sat(11, 0) })).blocked).toBe(
      true,
    );
    expect(evaluateRaceRestrictions(openingCtx({ candidateStartLocal: sat(11, 24) })).blocked).toBe(
      true,
    );
    // 1:00 PM Saturday is well outside the weekend opening window → allowed.
    expect(evaluateRaceRestrictions(openingCtx({ candidateStartLocal: sat(13, 0) })).blocked).toBe(
      false,
    );
  });

  it("uses the 11:00–11:30 AM window on Sunday", () => {
    expect(evaluateRaceRestrictions(openingCtx({ candidateStartLocal: sun(11, 12) })).blocked).toBe(
      true,
    );
    expect(evaluateRaceRestrictions(openingCtx({ candidateStartLocal: sun(11, 36) })).blocked).toBe(
      false,
    );
  });

  it("applies to every tier on Mega (not just one)", () => {
    expect(evaluateRaceRestrictions(openingCtx({ tier: "pro" })).blocked).toBe(true);
    expect(evaluateRaceRestrictions(openingCtx({ tier: "intermediate" })).blocked).toBe(true);
  });

  it("does not apply to non-Mega tracks", () => {
    const r = evaluateRaceRestrictions(openingCtx({ track: "Red" }));
    expect(r.blocked).toBe(false);
  });

  it("matches the track case-insensitively", () => {
    const r = evaluateRaceRestrictions(openingCtx({ track: "mega" }));
    expect(r.blocked).toBe(true);
  });

  it("does not block when candidateStartLocal is absent (epoch-only callers)", () => {
    const r = evaluateRaceRestrictions(openingCtx({ candidateStartLocal: undefined }));
    expect(r.blocked).toBe(false);
  });
});
