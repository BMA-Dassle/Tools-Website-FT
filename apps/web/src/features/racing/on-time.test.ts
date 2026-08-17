import { describe, it, expect } from "vitest";
import {
  CALL_LEAD_MIN,
  CALL_WINDOW_HEATS,
  LATE_CALL_MIN,
  MAX_PLAUSIBLE_OFFSET_MIN,
  callDelayMin,
  flagOffsetMin,
  median,
  onTimeByTrack,
  trackOnTime,
  type OnTimeHeat,
} from "./on-time";

const T0 = Date.parse("2026-08-16T20:00:00-04:00");
const min = (n: number) => n * 60_000;

/** A heat at slot `slotMin` past T0, called `calledOffset` min from its slot
 *  (negative = early) and going green `flagOffset` min past its slot. */
function heat(p: {
  id: string;
  track?: string;
  n?: number;
  slotMin: number;
  calledOffset?: number | null;
  flagOffset?: number | null;
}): OnTimeHeat {
  const slot = T0 + min(p.slotMin);
  return {
    sessionId: p.id,
    track: p.track ?? "blue",
    heatNumber: p.n ?? null,
    scheduledStartMs: slot,
    calledAtMs: p.calledOffset == null ? null : slot + min(p.calledOffset),
    actualStartMs: p.flagOffset == null ? null : slot + min(p.flagOffset),
  };
}

describe("median", () => {
  it("is null on empty rather than a confident zero", () => {
    expect(median([])).toBeNull();
  });

  it("averages the middle pair on an even count", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("ignores input order", () => {
    expect(median([9, -3, 1])).toBe(1);
  });
});

describe("callDelayMin — lateness measured against the CALL, not the flag", () => {
  it("is zero when the call lands exactly on policy", () => {
    expect(callDelayMin(heat({ id: "a", slotMin: 0, calledOffset: -CALL_LEAD_MIN }))).toBe(0);
  });

  it("reads NEGATIVE for the normal early call (Saturday's median was -4.8 vs slot)", () => {
    // Called 4.8 min before the slot, against a 5 min policy ⇒ +0.2.
    expect(callDelayMin(heat({ id: "a", slotMin: 0, calledOffset: -4.8 }))).toBeCloseTo(0.2, 5);
  });

  it("counts a call that goes out ON the slot as CALL_LEAD_MIN late", () => {
    expect(callDelayMin(heat({ id: "a", slotMin: 0, calledOffset: 0 }))).toBe(CALL_LEAD_MIN);
  });

  it("is null when the heat was never called — not zero", () => {
    expect(callDelayMin(heat({ id: "a", slotMin: 0, calledOffset: null }))).toBeNull();
  });

  it("is null when the slot is missing (every race before 2026-08-17)", () => {
    const h = { ...heat({ id: "a", slotMin: 0, calledOffset: -5 }), scheduledStartMs: null };
    expect(callDelayMin(h)).toBeNull();
  });
});

describe("flagOffsetMin — the pipeline, explicitly not a delay", () => {
  it("reads ~17 min on a perfectly ordinary heat", () => {
    expect(flagOffsetMin(heat({ id: "a", slotMin: 0, flagOffset: 16.1 }))).toBeCloseTo(16.1, 5);
  });

  it("drops Mega's nominal-slot artefact rather than publishing it", () => {
    // Mega's three heats on 2026-08-16 read 47-56 min against slots nobody ran to.
    expect(flagOffsetMin(heat({ id: "a", slotMin: 0, flagOffset: 56 }))).toBeNull();
    expect(
      flagOffsetMin(heat({ id: "b", slotMin: 0, flagOffset: MAX_PLAUSIBLE_OFFSET_MIN })),
    ).not.toBeNull();
  });

  it("is null before the flag drops", () => {
    expect(flagOffsetMin(heat({ id: "a", slotMin: 0, flagOffset: null }))).toBeNull();
  });
});

describe("trackOnTime", () => {
  const now = T0 + min(60);

  it("reads on-time through the normal night, where every call is early", () => {
    const heats = [
      heat({ id: "1", n: 1, slotMin: 0, calledOffset: -5, flagOffset: 16 }),
      heat({ id: "2", n: 2, slotMin: 12, calledOffset: -4.5, flagOffset: 18 }),
      heat({ id: "3", n: 3, slotMin: 24, calledOffset: -5.2, flagOffset: 15 }),
    ];
    const r = trackOnTime("blue", heats, now);
    expect(r.status).toBe("on-time");
    // delays are [0, +0.5, -0.2] ⇒ median 0. Sitting on the policy is the
    // ordinary state of this track, which is exactly why an averaged readout
    // would be permanently green and therefore worthless.
    expect(r.callDelayMin).toBe(0);
    expect(r.callDelayN).toBe(3);
    expect(r.lateCalls).toEqual([]);
  });

  it("surfaces a late call as an EXCEPTION even while the median stays green", () => {
    // This is the whole point: 8 of 99 calls were late on 2026-08-16 and the
    // median never moved off ~0. An averaged number would hide all eight.
    const heats = [
      heat({ id: "1", n: 1, slotMin: 0, calledOffset: -5 }),
      heat({ id: "2", n: 2, slotMin: 12, calledOffset: +16 }), // +21 vs policy
      heat({ id: "3", n: 3, slotMin: 24, calledOffset: -5 }),
    ];
    const r = trackOnTime("blue", heats, now);
    expect(r.status).toBe("on-time"); // median of [0, 21, 0] = 0
    expect(r.callDelayMin).toBe(0);
    expect(r.lateCalls).toHaveLength(1);
    expect(r.lateCalls[0].heatNumber).toBe(2);
    expect(r.lateCalls[0].delayMin).toBeCloseTo(21, 5);
  });

  it("goes BEHIND only when the median itself clears the slot", () => {
    const heats = [
      heat({ id: "1", n: 1, slotMin: 0, calledOffset: +8 }),
      heat({ id: "2", n: 2, slotMin: 12, calledOffset: +9 }),
      heat({ id: "3", n: 3, slotMin: 24, calledOffset: +10 }),
    ];
    const r = trackOnTime("blue", heats, now);
    expect(r.status).toBe("behind");
    expect(r.callDelayMin).toBeGreaterThan(LATE_CALL_MIN);
    expect(r.lateCalls).toHaveLength(3);
  });

  it("medians only the last CALL_WINDOW_HEATS, so an old bad call stops moving it", () => {
    const heats = [
      heat({ id: "old", n: 1, slotMin: 0, calledOffset: +20 }),
      heat({ id: "2", n: 2, slotMin: 12, calledOffset: -5 }),
      heat({ id: "3", n: 3, slotMin: 24, calledOffset: -5 }),
      heat({ id: "4", n: 4, slotMin: 36, calledOffset: -5 }),
    ];
    const r = trackOnTime("blue", heats, now);
    expect(r.callDelayN).toBe(CALL_WINDOW_HEATS);
    expect(r.callDelayMin).toBe(0);
    // …but it is still listed as an exception, because it really happened.
    expect(r.lateCalls).toHaveLength(1);
  });

  it("is unknown — never on-time — when nothing carried a slot", () => {
    const heats: OnTimeHeat[] = [
      { ...heat({ id: "1", slotMin: 0, calledOffset: -5 }), scheduledStartMs: null },
    ];
    const r = trackOnTime("blue", heats, now);
    expect(r.status).toBe("unknown");
    expect(r.callDelayMin).toBeNull();
    expect(r.callDelayN).toBe(0);
  });

  it("ignores other tracks entirely", () => {
    const heats = [
      heat({ id: "b1", track: "blue", slotMin: 0, calledOffset: -5 }),
      heat({ id: "r1", track: "red", slotMin: 0, calledOffset: +20 }),
    ];
    expect(trackOnTime("blue", heats, now).lateCalls).toEqual([]);
    expect(trackOnTime("red", heats, now).lateCalls).toHaveLength(1);
  });

  it("takes the flag offset from the LAST heat that went green", () => {
    const heats = [
      heat({ id: "1", n: 1, slotMin: 0, calledOffset: -5, flagOffset: 25 }),
      heat({ id: "2", n: 2, slotMin: 12, calledOffset: -5, flagOffset: 14 }),
      heat({ id: "3", n: 3, slotMin: 24, calledOffset: -5, flagOffset: null }),
    ];
    const r = trackOnTime("blue", heats, now);
    expect(r.flagOffsetMin).toBe(14);
    expect(r.flagOffsetHeatNumber).toBe(2);
  });

  it("drops calls that have aged out of the recent window", () => {
    const stale = heat({ id: "old", slotMin: -200, calledOffset: +30 });
    const r = trackOnTime("blue", [stale], now);
    expect(r.callDelayN).toBe(0);
    expect(r.lateCalls).toEqual([]);
  });
});

describe("onTimeByTrack", () => {
  it("keeps the tracks apart — they are separately staffed and separately late", () => {
    const now = T0 + min(60);
    const heats = [
      heat({ id: "b1", track: "blue", slotMin: 0, calledOffset: -5 }),
      heat({ id: "r1", track: "red", slotMin: 0, calledOffset: +20 }),
    ];
    const r = onTimeByTrack(heats, now);
    expect(Object.keys(r).sort()).toEqual(["blue", "red"]);
    expect(r.blue.status).toBe("on-time");
    expect(r.red.status).toBe("behind");
  });

  it("does not invent a bucket for a track with no heats", () => {
    expect(Object.keys(onTimeByTrack([], T0))).toEqual([]);
  });
});
