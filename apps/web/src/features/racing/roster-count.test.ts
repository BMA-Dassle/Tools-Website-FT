import { describe, expect, it } from "vitest";
import {
  applyLocalFloor,
  parseStoredRoster,
  resolveRosterCount,
  rosterIsFresh,
  rosterIsUsableWhenStale,
  ROSTER_FRESH_MS,
  ROSTER_MAX_STALE_MS,
  UNKNOWN_ROSTER,
  type RosterCount,
} from "./roster-count";

const NOW = 1_755_000_000_000;
const stored = (checkedIn: number, total: number, ageMs: number): RosterCount => ({
  checkedIn,
  total,
  atMs: NOW - ageMs,
  stale: false,
});

describe("rosterIsFresh", () => {
  it("serves a count read a moment ago without going upstream", () => {
    expect(rosterIsFresh(stored(3, 5, 1_000), NOW)).toBe(true);
  });

  it("re-reads once the count passes the shared window", () => {
    expect(rosterIsFresh(stored(3, 5, ROSTER_FRESH_MS + 1), NOW)).toBe(false);
  });

  it("re-reads rather than trusting a stamp from the future", () => {
    // Two lambdas with skewed clocks; never let that pin a count as fresh.
    expect(rosterIsFresh(stored(3, 5, -60_000), NOW)).toBe(false);
  });

  it("treats nothing known as not fresh", () => {
    expect(rosterIsFresh(null, NOW)).toBe(false);
    expect(rosterIsFresh(UNKNOWN_ROSTER, NOW)).toBe(false);
  });
});

describe("resolveRosterCount", () => {
  it("a fresh read wins and is not stale", () => {
    expect(resolveRosterCount({ checkedIn: 5, total: 5 }, stored(0, 5, 5_000), NOW)).toEqual({
      checkedIn: 5,
      total: 5,
      atMs: NOW,
      stale: false,
    });
  });

  it("A FAILED READ KEEPS THE LAST COUNT — this is the whole fix", () => {
    // 2026-08-18: Pandora was answering 5/5 in under a second from Fort Myers
    // and timing out from iad1. The board printed 0/0 over five racers who
    // were standing at the desk, already scanned.
    const out = resolveRosterCount(null, stored(5, 5, 8_000), NOW);
    expect(out.checkedIn).toBe(5);
    expect(out.total).toBe(5);
    expect(out.stale).toBe(true);
    // It keeps the age it was actually counted at, not "now".
    expect(out.atMs).toBe(NOW - 8_000);
  });

  it("NEVER reports a failed read as zero", () => {
    const out = resolveRosterCount(null, null, NOW);
    expect(out.checkedIn).toBeNull();
    expect(out.total).toBeNull();
    // The precise regression: 0/0 is a claim that nobody is booked on the heat.
    expect(out.checkedIn).not.toBe(0);
    expect(out.total).not.toBe(0);
  });

  it("lets a count from a heat that surely ended lapse to unknown", () => {
    const out = resolveRosterCount(null, stored(5, 5, ROSTER_MAX_STALE_MS + 1), NOW);
    expect(out).toEqual(UNKNOWN_ROSTER);
  });

  it("carries an empty heat forward as a counted zero, not as unknown", () => {
    // 0 of 0 IS a real answer when we counted it — an unbooked heat. The rule is
    // that we may not INVENT it, not that zero is forbidden.
    const out = resolveRosterCount(null, stored(0, 0, 5_000), NOW);
    expect(out.total).toBe(0);
    expect(out.stale).toBe(true);
  });

  it("keeps a real 0-of-7 fresh read as a fresh zero", () => {
    // A heat that just rolled: seven booked, nobody scanned yet.
    const out = resolveRosterCount({ checkedIn: 0, total: 7 }, stored(5, 5, 3_000), NOW);
    expect(out).toEqual({ checkedIn: 0, total: 7, atMs: NOW, stale: false });
  });
});

describe("rosterIsUsableWhenStale", () => {
  it("holds a count for the life of a called heat", () => {
    expect(rosterIsUsableWhenStale(stored(3, 5, 19 * 60_000), NOW)).toBe(true);
  });

  it("drops it once it outlives any plausible heat", () => {
    expect(rosterIsUsableWhenStale(stored(3, 5, ROSTER_MAX_STALE_MS), NOW)).toBe(false);
  });
});

describe("applyLocalFloor", () => {
  it("a count can never fall below the people this desk scanned", () => {
    // Pandora has not caught up with the last two scans.
    const out = applyLocalFloor(stored(3, 7, 0), 5);
    expect(out.checkedIn).toBe(5);
  });

  it("leaves a fresher upstream answer alone", () => {
    // Somebody was checked in at another station — Pandora knows more than we do.
    const out = applyLocalFloor(stored(6, 7, 0), 5);
    expect(out.checkedIn).toBe(6);
  });

  it("never reports more scanned than the grid holds", () => {
    // A stale roster (total from the previous, smaller heat) must not print 6/5.
    const out = applyLocalFloor(stored(4, 5, 0), 6);
    expect(out.checkedIn).toBe(5);
    expect(out.total).toBe(5);
  });

  it("cannot invent a count where there is none", () => {
    expect(applyLocalFloor(UNKNOWN_ROSTER, 4)).toEqual(UNKNOWN_ROSTER);
  });

  it("is a no-op when this desk has scanned nobody", () => {
    expect(applyLocalFloor(stored(2, 6, 0), 0).checkedIn).toBe(2);
  });
});

describe("parseStoredRoster", () => {
  it("reads back what we wrote", () => {
    const raw = JSON.stringify({ checkedIn: 2, total: 6, atMs: NOW, stale: false });
    expect(parseStoredRoster(raw)).toEqual({ checkedIn: 2, total: 6, atMs: NOW, stale: false });
  });

  it("treats a half-written or foreign value as nothing known, never as zero", () => {
    expect(parseStoredRoster(null)).toBeNull();
    expect(parseStoredRoster("")).toBeNull();
    expect(parseStoredRoster("{")).toBeNull();
    expect(parseStoredRoster(JSON.stringify({ checkedIn: 2 }))).toBeNull();
    expect(parseStoredRoster(JSON.stringify({ checkedIn: 2, total: 6 }))).toBeNull();
    expect(
      parseStoredRoster(JSON.stringify({ checkedIn: null, total: null, atMs: NOW })),
    ).toBeNull();
  });
});
