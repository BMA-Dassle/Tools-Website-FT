import { describe, expect, it } from "vitest";
import {
  GROUP_OUT_WINDOW_MS,
  RETURN_GRACE_MS,
  liveHeatNumber,
  roomReturnStateAt,
  type GroupOut,
} from "./room-return";

const NOW = 1_786_487_400_000;

function group(over: Partial<GroupOut> = {}): GroupOut {
  return {
    sessionId: "58509204",
    heatNumber: 23,
    sentAtMs: NOW - 8 * 60_000,
    endedAtMs: null,
    ...over,
  };
}

describe("roomReturnStateAt", () => {
  it("a room that has briefed nobody is free", () => {
    expect(roomReturnStateAt({ group: null, liveHeat: null, megaDay: false, nowMs: NOW })).toEqual({
      kind: "free",
    });
  });

  it("counts the group back off the on-track clock when their heat is running", () => {
    const state = roomReturnStateAt({
      group: group(),
      liveHeat: { heatNumber: 23, remainingMs: 252_000 },
      megaDay: false,
      nowMs: NOW,
    });
    expect(state).toEqual({ kind: "racing", heatNumber: 23, remainingMs: 252_000 });
  });

  it("says on-grid while an EARLIER heat is still on track — ours has not gone green", () => {
    expect(
      roomReturnStateAt({
        group: group({ heatNumber: 23 }),
        liveHeat: { heatNumber: 22, remainingMs: 60_000 },
        megaDay: false,
        nowMs: NOW,
      }),
    ).toEqual({ kind: "on-grid", heatNumber: 23 });
  });

  it("frees the room when a LATER heat is on track — ours finished, stamp never arrived", () => {
    // The bridge-outage path: no end marker, but heat 25 racing proves 23 is done.
    expect(
      roomReturnStateAt({
        group: group({ heatNumber: 23 }),
        liveHeat: { heatNumber: 25, remainingMs: 300_000 },
        megaDay: false,
        nowMs: NOW,
      }),
    ).toEqual({ kind: "free" });
  });

  it("says on-grid when nothing is running on their track yet", () => {
    expect(
      roomReturnStateAt({ group: group(), liveHeat: null, megaDay: false, nowMs: NOW }),
    ).toEqual({ kind: "on-grid", heatNumber: 23 });
  });

  describe("the end stamp settles it", () => {
    it("holds 'returning' inside the grace window", () => {
      const state = roomReturnStateAt({
        group: group({ endedAtMs: NOW - 20_000 }),
        liveHeat: null,
        megaDay: false,
        nowMs: NOW,
      });
      expect(state).toEqual({ kind: "returning", heatNumber: 23, sinceEndMs: 20_000 });
    });

    it("is free once the grace window passes (owner: free about a minute after the flag)", () => {
      expect(
        roomReturnStateAt({
          group: group({ endedAtMs: NOW - RETURN_GRACE_MS - 1 }),
          liveHeat: null,
          megaDay: false,
          nowMs: NOW,
        }),
      ).toEqual({ kind: "free" });
    });

    it("outranks a live clock — a stamped end is not up for debate", () => {
      // Their heat ended; the clock now belongs to whoever went out next.
      expect(
        roomReturnStateAt({
          group: group({ heatNumber: 23, endedAtMs: NOW - 5 * 60_000 }),
          liveHeat: { heatNumber: 23, remainingMs: 200_000 },
          megaDay: false,
          nowMs: NOW,
        }),
      ).toEqual({ kind: "free" });
    });

    it("treats a future stamp (clock skew) as just-finished, never as back", () => {
      const state = roomReturnStateAt({
        group: group({ endedAtMs: NOW + 4_000 }),
        liveHeat: null,
        megaDay: false,
        nowMs: NOW,
      });
      expect(state).toEqual({ kind: "returning", heatNumber: 23, sinceEndMs: 0 });
    });
  });

  describe("an unnameable heat", () => {
    it("is claimed on a Red/Blue day — the room's own track, the room's own group", () => {
      expect(
        roomReturnStateAt({
          group: group(),
          liveHeat: { heatNumber: null, remainingMs: 120_000 },
          megaDay: false,
          nowMs: NOW,
        }),
      ).toEqual({ kind: "racing", heatNumber: 23, remainingMs: 120_000 });
    });

    it("is NOT claimed on a Mega day — one circuit, two rooms, no coin flips", () => {
      expect(
        roomReturnStateAt({
          group: group(),
          liveHeat: { heatNumber: null, remainingMs: 120_000 },
          megaDay: true,
          nowMs: NOW,
        }),
      ).toEqual({ kind: "free" });
    });

    it("does not claim a Mega race for a send row with no heat number either", () => {
      expect(
        roomReturnStateAt({
          group: group({ heatNumber: null }),
          liveHeat: { heatNumber: 66, remainingMs: 120_000 },
          megaDay: true,
          nowMs: NOW,
        }),
      ).toEqual({ kind: "free" });
    });

    it("still matches a NAMED Mega heat against the room's own group", () => {
      expect(
        roomReturnStateAt({
          group: group({ heatNumber: 66 }),
          liveHeat: { heatNumber: 66, remainingMs: 90_000 },
          megaDay: true,
          nowMs: NOW,
        }),
      ).toEqual({ kind: "racing", heatNumber: 66, remainingMs: 90_000 });
    });
  });

  describe("nothing holds a room forever", () => {
    it("frees a room whose group was sent longer ago than the out window", () => {
      expect(
        roomReturnStateAt({
          group: group({ sentAtMs: NOW - GROUP_OUT_WINDOW_MS - 1 }),
          liveHeat: { heatNumber: 23, remainingMs: 200_000 },
          megaDay: false,
          nowMs: NOW,
        }),
      ).toEqual({ kind: "free" });
    });

    it("ignores a send row with an unparseable timestamp", () => {
      expect(
        roomReturnStateAt({
          group: group({ sentAtMs: NaN }),
          liveHeat: null,
          megaDay: false,
          nowMs: NOW,
        }),
      ).toEqual({ kind: "free" });
    });
  });

  it("never reports a negative countdown", () => {
    const state = roomReturnStateAt({
      group: group(),
      liveHeat: { heatNumber: 23, remainingMs: -500 },
      megaDay: false,
      nowMs: NOW,
    });
    expect(state).toEqual({ kind: "racing", heatNumber: 23, remainingMs: 0 });
  });
});

describe("liveHeatNumber", () => {
  // Both real shapes: the raw cloud frame, and what useLiveSessionClock hands a
  // component after it rewrites the marker.
  it("reads the raw cloud-socket name", () => {
    expect(liveHeatNumber("[HEAT] 66 - Mega Pro")).toBe(66);
    expect(liveHeatNumber("[HEAT] 57")).toBe(57);
  });

  it("reads the humanised name the live-session hook publishes", () => {
    expect(liveHeatNumber("Heat 66 - Mega Pro")).toBe(66);
    expect(liveHeatNumber("Heat 70 - Blue Starter")).toBe(70);
    expect(liveHeatNumber("Heat 9")).toBe(9);
  });

  /**
   * THE SHAPE THE VENUE ACTUALLY SENDS, and the one this helper used to miss
   * entirely (owner 2026-08-14: "I started blue 61 and it didn't move it from
   * holding to on track").
   *
   * The venue broadcast's own `Name` carries no "heat" word at all — these are
   * verbatim from live finish markers and the kart-events queue survey. Every
   * match on heat number silently failed against them.
   */
  it("reads the venue's own leading-number name", () => {
    expect(liveHeatNumber("61 - Blue Starter")).toBe(61);
    expect(liveHeatNumber("60 - Blue Intermediate")).toBe(60);
    expect(liveHeatNumber("66 - Mega Pro")).toBe(66);
    expect(liveHeatNumber("43 - Blue Starter")).toBe(43);
    expect(liveHeatNumber("9 - Red Junior Starter")).toBe(9);
  });

  it("is null for an unnumbered or missing name", () => {
    expect(liveHeatNumber("Corporate Event")).toBeNull();
    expect(liveHeatNumber("")).toBeNull();
    expect(liveHeatNumber(null)).toBeNull();
    expect(liveHeatNumber(undefined)).toBeNull();
  });

  /** A number has to be the heat's own, not merely present. The leading-number
   *  rule must not turn a year or a lane count into a heat. */
  it("does not invent a heat from a number buried in a name", () => {
    expect(liveHeatNumber("Corporate Event 2024")).toBeNull();
    expect(liveHeatNumber("Birthday party - 12 racers")).toBeNull();
  });
});
