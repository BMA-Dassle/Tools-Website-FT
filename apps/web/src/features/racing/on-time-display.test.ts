import { describe, it, expect } from "vitest";
import { MIN_SLOT_COVERAGE, trackDisplay, verdictLabel } from "./on-time-display";
import type { OnTimeSnapshot, TrackOnTime } from "./on-time";

const NOW = Date.parse("2026-08-16T20:00:00-04:00");
const SLOT = Date.parse("2026-08-16T20:12:00-04:00");

function track(over: Partial<TrackOnTime> = {}): TrackOnTime {
  return {
    track: "blue",
    status: "on-time",
    callDelayMin: 0.2,
    callDelayN: 3,
    lateCalls: [],
    flagOffsetMin: 16.1,
    flagOffsetHeatNumber: 42,
    flagOffsetAtMs: NOW,
    // Saturday's real Blue figures — the p90 is what a "racing by" bound uses.
    dayOffsetMedianMin: 18.2,
    dayOffsetP90Min: 24.9,
    dayOffsetN: 54,
    ...over,
  };
}

function snap(t: Partial<TrackOnTime> = {}, withSlot = 40): OnTimeSnapshot {
  return {
    businessDay: "2026-08-16",
    tracks: { blue: track(t) },
    atMs: NOW,
    slotCoverage: { withSlot, total: 40 },
  };
}

describe("trackDisplay — the guest number is the CHECK-IN time", () => {
  it("passes the printed slot straight through, unadjusted", () => {
    // The flag lands ~16 min after the slot, but check-in lands ON it. Shifting
    // this would send a guest to a desk that had already closed.
    const d = trackDisplay(snap(), "blue", SLOT);
    expect(d.checkInAtMs).toBe(SLOT);
  });

  it("still gives the check-in time on a night too thin to score", () => {
    // The slot is true whether or not we measured anything tonight. Only the
    // VERDICT needs data.
    const d = trackDisplay(snap({}, MIN_SLOT_COVERAGE - 1), "blue", SLOT);
    expect(d.insufficientData).toBe(true);
    expect(d.checkInAtMs).toBe(SLOT);
  });

  it("has no check-in time when nothing is checking in on this track", () => {
    expect(trackDisplay(snap(), "blue", null).checkInAtMs).toBeNull();
  });

  it("survives a missing snapshot entirely", () => {
    const d = trackDisplay(null, "blue", SLOT);
    expect(d.checkInAtMs).toBe(SLOT);
    expect(d.insufficientData).toBe(true);
    // Green, not grey — the check-in time is still true and nothing is known
    // to be wrong.
    expect(d.tone).toBe("ok");
  });
});

describe("verdictLabel — what the TVs show", () => {
  it("reads On Time on the ordinary night", () => {
    expect(verdictLabel(trackDisplay(snap(), "blue", SLOT))).toBe("On Time");
  });

  it("reads +N late once the MEDIAN call clears the slot", () => {
    const d = trackDisplay(snap({ status: "behind", callDelayMin: 13.6 }), "blue", SLOT);
    expect(verdictLabel(d)).toBe("+14 late");
    expect(d.lateByMin).toBe(14);
  });

  it("stays On Time through a SINGLE late call, so a wall cannot flicker", () => {
    // One bad call is a staff exception, not a track-wide verdict — it belongs
    // on the marshal board's sub-line, not on the guest wall's headline.
    const d = trackDisplay(
      snap({
        callDelayMin: 0.2,
        lateCalls: [{ sessionId: "x", heatNumber: 31, delayMin: 14, calledAtMs: NOW }],
      }),
      "blue",
      SLOT,
    );
    expect(verdictLabel(d)).toBe("On Time");
    expect(d.lateCalls).toHaveLength(1);
  });

  // Owner 2026-08-17: "if no data or outside of business hours just mark tracks
  // as on-time." A blank board reads as broken; green is the default.
  it("reads On Time on a night too thin to score, rather than going quiet", () => {
    const d = trackDisplay(snap({}, MIN_SLOT_COVERAGE - 1), "blue", SLOT);
    expect(verdictLabel(d)).toBe("On Time");
    // …but it still ADMITS it, so a staff surface can say why underneath.
    expect(d.insufficientData).toBe(true);
  });

  it("reads On Time for a track that has run nothing", () => {
    expect(verdictLabel(trackDisplay(snap(), "red", SLOT))).toBe("On Time");
  });

  it("reads On Time with no snapshot at all — the closed building", () => {
    // Before opening and after the last heat both arrive here: no heats today,
    // or every call aged out of the recent window. Indistinguishable from
    // "nothing is wrong", which is what green means.
    const d = trackDisplay(null, "blue", null);
    expect(verdictLabel(d)).toBe("On Time");
    expect(d.tone).toBe("ok");
  });
});

describe("tone", () => {
  it("stays quiet through the ordinary ~17-minute pipeline", () => {
    // The whole point: a long briefing pipeline is not a fault, and lighting
    // amber for it would make every screen amber every night.
    expect(trackDisplay(snap({ flagOffsetMin: 28 }), "blue", SLOT).tone).toBe("ok");
  });

  it("warns only when the calls themselves are behind", () => {
    expect(trackDisplay(snap({ status: "behind", callDelayMin: 9 }), "blue", SLOT).tone).toBe(
      "warn",
    );
  });
});
