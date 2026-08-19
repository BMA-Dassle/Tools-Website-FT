import { describe, expect, it } from "vitest";
import {
  applyLocalFloor,
  applyOwnScanCredit,
  parseStoredRoster,
  resolveRosterCount,
  rosterIsFresh,
  rosterIsFreshForWire,
  rosterIsUsableWhenStale,
  ROSTER_FRESH_MS,
  ROSTER_MAX_STALE_MS,
  ROSTER_WIRE_FRESH_MS,
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

describe("rosterIsFreshForWire", () => {
  const W = 1_760_000_000_000;
  const stored: RosterCount = { checkedIn: 6, total: 14, atMs: W - 30_000, stale: false };

  it("serves a stored count the wire has said nothing about", () => {
    // 30s old — past ROSTER_FRESH_MS, so today this bought a Pandora read.
    expect(
      rosterIsFreshForWire({
        entry: stored,
        nowMs: W,
        dirtyCounter: 3,
        readCounter: 3,
        bridgeAlive: true,
      }),
    ).toBe(true);
  });

  it("re-reads the instant the wire says the session moved", () => {
    expect(
      rosterIsFreshForWire({
        entry: stored,
        nowMs: W,
        dirtyCounter: 4,
        readCounter: 3,
        bridgeAlive: true,
      }),
    ).toBe(false);
  });

  it("falls back to the plain clock window when the bridge is dead", () => {
    // Silence from a dead pipe is not evidence of a quiet venue.
    expect(
      rosterIsFreshForWire({
        entry: stored,
        nowMs: W,
        dirtyCounter: 3,
        readCounter: 3,
        bridgeAlive: false,
      }),
    ).toBe(false);
    // ...but a count inside the plain window is still served, exactly as before.
    expect(
      rosterIsFreshForWire({
        entry: { ...stored, atMs: W - 1_000 },
        nowMs: W,
        dirtyCounter: null,
        readCounter: null,
        bridgeAlive: false,
      }),
    ).toBe(true);
  });

  it("re-reads when this consumer has never banked a counter", () => {
    expect(
      rosterIsFreshForWire({
        entry: stored,
        nowMs: W,
        dirtyCounter: 3,
        readCounter: null,
        bridgeAlive: true,
      }),
    ).toBe(false);
  });

  it("treats an expired dirty key that restarted below us as movement", () => {
    expect(
      rosterIsFreshForWire({
        entry: stored,
        nowMs: W,
        dirtyCounter: null,
        readCounter: 3,
        bridgeAlive: true,
      }),
    ).toBe(false);
  });

  it("stops trusting the wire once the count is older than the wire window", () => {
    expect(
      rosterIsFreshForWire({
        entry: { ...stored, atMs: W - ROSTER_WIRE_FRESH_MS },
        nowMs: W,
        dirtyCounter: 3,
        readCounter: 3,
        bridgeAlive: true,
      }),
    ).toBe(false);
  });

  it("re-reads on a future stamp rather than trusting a skewed clock", () => {
    expect(
      rosterIsFreshForWire({
        entry: { ...stored, atMs: W + 5_000 },
        nowMs: W,
        dirtyCounter: 3,
        readCounter: 3,
        bridgeAlive: true,
      }),
    ).toBe(false);
  });

  it("never serves a count that was never read", () => {
    expect(
      rosterIsFreshForWire({
        entry: null,
        nowMs: W,
        dirtyCounter: 3,
        readCounter: 3,
        bridgeAlive: true,
      }),
    ).toBe(false);
  });
});

describe("applyOwnScanCredit — the board crediting its own scan", () => {
  const FT = "LAB52GY480CJF";
  const HP = "TXBSQN0FEKQ11";
  const row = (over: Partial<Parameters<typeof applyOwnScanCredit>[0][number]> = {}) => ({
    sessionId: 58996064,
    locationId: FT,
    checkedIn: 4 as number | null,
    total: 6 as number | null,
    stale: false,
    ...over,
  });

  it("raises the scanned row's count without waiting for a poll", () => {
    const out = applyOwnScanCredit([row()], { locationId: FT, sessionId: 58996064, count: 5 });
    expect(out[0].checkedIn).toBe(5);
    expect(out[0].total).toBe(6);
  });

  it("matches a session id given as a string against a numeric row", () => {
    const out = applyOwnScanCredit([row()], { locationId: FT, sessionId: "58996064", count: 5 });
    expect(out[0].checkedIn).toBe(5);
  });

  it("never lowers a count Pandora already had higher", () => {
    // Two more racers checked in at another station, or directly in BMI.
    const out = applyOwnScanCredit([row({ checkedIn: 6 })], {
      locationId: FT,
      sessionId: 58996064,
      count: 3,
    });
    expect(out[0].checkedIn).toBe(6);
  });

  it("never exceeds the grid total", () => {
    const out = applyOwnScanCredit([row({ checkedIn: 2, total: 4 })], {
      locationId: FT,
      sessionId: 58996064,
      count: 9,
    });
    expect(out[0].checkedIn).toBe(4);
  });

  it("leaves a row whose roster could not be read as unknown", () => {
    // "3 of —" is not a number to put in front of a marshal.
    const out = applyOwnScanCredit([row({ checkedIn: null, total: null })], {
      locationId: FT,
      sessionId: 58996064,
      count: 3,
    });
    expect(out[0].checkedIn).toBeNull();
    expect(out[0].total).toBeNull();
  });

  it("leaves every other heat alone", () => {
    const rows = [row(), row({ sessionId: 58996065, checkedIn: 1 })];
    const out = applyOwnScanCredit(rows, { locationId: FT, sessionId: 58996064, count: 5 });
    expect(out[1].checkedIn).toBe(1);
    expect(out[1]).toBe(rows[1]);
  });

  it("does not credit an identical session id on another BMI server", () => {
    // FT/HP-FM and Naples mint session ids independently and they collide.
    const rows = [row({ locationId: HP })];
    const out = applyOwnScanCredit(rows, { locationId: FT, sessionId: 58996064, count: 5 });
    expect(out[0].checkedIn).toBe(4);
    expect(out[0]).toBe(rows[0]);
  });

  it("fails OPEN on a row served before locationId existed", () => {
    const out = applyOwnScanCredit([row({ locationId: undefined })], {
      locationId: FT,
      sessionId: 58996064,
      count: 5,
    });
    expect(out[0].checkedIn).toBe(5);
  });

  it("returns rows by identity when nothing moved, so the strip does not re-render", () => {
    const rows = [row()];
    const out = applyOwnScanCredit(rows, { locationId: FT, sessionId: 58996064, count: 4 });
    expect(out[0]).toBe(rows[0]);
  });

  it("is a no-op on an empty ledger rather than a zero floor", () => {
    const rows = [row()];
    expect(applyOwnScanCredit(rows, { locationId: FT, sessionId: 58996064, count: 0 })).toBe(rows);
  });
});
