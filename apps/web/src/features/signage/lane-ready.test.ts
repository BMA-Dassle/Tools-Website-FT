import { describe, it, expect } from "vitest";
import {
  laneReadyKey,
  encodeLaneReady,
  parseLaneReady,
  parseLaneReadySet,
  LANE_READY_TTL_SECONDS,
} from "./lane-ready";

/**
 * The contract between the every-minute cron that WRITES readiness and the TV feed that
 * READS it. They run in different runtimes, so a shape mismatch here is a wall that is
 * silently always empty and a cron that silently always succeeds.
 */

describe("the key", () => {
  it("is namespaced and versioned, and keyed by the centre", () => {
    expect(laneReadyKey("TXBSQN0FEKQ11")).toBe("bowling:laneready:v1:TXBSQN0FEKQ11");
    expect(laneReadyKey("PPTR5G2N0QXF7")).not.toBe(laneReadyKey("TXBSQN0FEKQ11"));
  });

  it("survives three missed runs before the wall goes quiet", () => {
    // One-minute cadence. Generous on purpose: a guest listed as able to check in who
    // vanishes mid-walk because one run was slow is worse than a name lingering a minute.
    expect(LANE_READY_TTL_SECONDS).toBeGreaterThanOrEqual(180);
  });
});

describe("encode / parse round trip", () => {
  it("carries the reservation id and its lanes", () => {
    expect(parseLaneReady(encodeLaneReady(1234, [12, 13]))).toEqual({
      reservationId: 1234,
      lanes: "12,13",
    });
  });

  it("survives a reservation with no lane numbers yet", () => {
    // A booked lane marked Ready in Conqueror before numbers are visible. Still ready —
    // the guest can check in; the wall just cannot name the lane.
    expect(parseLaneReady(encodeLaneReady(77, []))).toEqual({ reservationId: 77, lanes: "" });
  });

  it("handles a single lane", () => {
    expect(parseLaneReady(encodeLaneReady(9, [4]))).toEqual({ reservationId: 9, lanes: "4" });
  });
});

describe("malformed members degrade, never throw", () => {
  it("returns null rather than throwing on junk", () => {
    // A value from an older deploy, or a half-written key. A wall that has run unattended
    // for weeks must degrade to "nobody ready", not to a stack trace.
    for (const junk of ["", ":", "abc", "abc:12", "-1:12", "0:12", "1.5:12", ":12"]) {
      expect(parseLaneReady(junk), junk).toBeNull();
    }
  });

  it("drops the bad members and keeps the good ones", () => {
    const set = parseLaneReadySet(["12:5", "junk", "34:", "0:9", "56:7,8"]);
    expect([...set.keys()].sort((a, b) => a - b)).toEqual([12, 34, 56]);
    expect(set.get(56)?.lanes).toBe("7,8");
    expect(set.get(34)?.lanes).toBe("");
  });

  it("an empty set is an empty map, which empties the column", () => {
    // Deliberate: no readiness data means "do not invite anybody", whether that is
    // because nobody is ready or because the cron has not run.
    expect(parseLaneReadySet([]).size).toBe(0);
  });

  it("keys by reservation id so the feed can join against its Neon rows", () => {
    const set = parseLaneReadySet([encodeLaneReady(4242, [1])]);
    expect(set.has(4242)).toBe(true);
    expect(set.has(4243)).toBe(false);
  });
});
