import { describe, it, expect } from "vitest";
import { resolveLanePhase, laneLabel, SELF_SERVICE_WINDOW_MINS } from "@/lib/bowling-lane-phase";
import type { BookedLane, Lane } from "@/lib/qamf-bowling";

/**
 * The lane state machine, which decides whether the front-desk wall may invite a guest
 * to check themselves in. Every case here is a way that invitation could be wrong.
 */

const NOW = Date.parse("2026-08-19T19:00:00-04:00");
const bl = (n: number, status: BookedLane["Status"]): BookedLane => ({
  Id: `bl-${n}`,
  Status: status,
  LaneNumber: n,
  StartTime: "2026-08-19T19:00:00",
  EndTime: "2026-08-19T20:30:00",
});
const pl = (n: number, status: Lane["Status"]): Lane => ({ LaneNumber: n, Status: status });

/** Booked `mins` from now — negative means the slot has already started. */
const at = (mins: number) => NOW + mins * 60_000;

describe("resolveLanePhase — the plain booked-lane statuses", () => {
  it("Ready means a guest may open it, whatever the hardware says", () => {
    const r = resolveLanePhase({
      lanes: [bl(12, "Ready")],
      physicalLanes: [pl(12, "Error")],
      bookedAtMs: at(120),
      nowMs: NOW,
    });
    expect(r.phase).toBe("ready");
    expect(r.canSelfCheckIn).toBe(true);
    expect(r.gate).toBe("booked-lane-ready");
  });

  it("Running is NOT ready — there is nothing left to open", () => {
    const r = resolveLanePhase({
      lanes: [bl(12, "Running")],
      physicalLanes: [pl(12, "Open")],
      bookedAtMs: at(-10),
      nowMs: NOW,
    });
    expect(r.phase).toBe("running");
    expect(r.canSelfCheckIn).toBe(false);
  });

  it("Completed wins over a sibling lane still Running", () => {
    // Precedence matters: a finished reservation is done even if one lane lags.
    const r = resolveLanePhase({
      lanes: [bl(12, "Completed"), bl(13, "Running")],
      physicalLanes: [],
      bookedAtMs: at(-120),
      nowMs: NOW,
    });
    expect(r.phase).toBe("completed");
    expect(r.canSelfCheckIn).toBe(false);
  });

  it("Running wins over a sibling lane merely Ready", () => {
    const r = resolveLanePhase({
      lanes: [bl(12, "Running"), bl(13, "Ready")],
      physicalLanes: [],
      bookedAtMs: at(-5),
      nowMs: NOW,
    });
    expect(r.phase).toBe("running");
  });

  it("no lanes assigned at all is not_ready, and never invites anybody", () => {
    const r = resolveLanePhase({
      lanes: [],
      physicalLanes: [pl(12, "Closed")],
      bookedAtMs: at(5),
      nowMs: NOW,
    });
    expect(r.phase).toBe("not_ready");
    expect(r.canSelfCheckIn).toBe(false);
    expect(r.laneNumbers).toEqual([]);
  });
});

describe("resolveLanePhase — the self-service gate", () => {
  const confirmed = [bl(12, "Confirmed"), bl(13, "Confirmed")];

  it("opens inside the window when every assigned lane is physically Closed", () => {
    const r = resolveLanePhase({
      lanes: confirmed,
      physicalLanes: [pl(12, "Closed"), pl(13, "Closed"), pl(14, "Open")],
      bookedAtMs: at(10),
      nowMs: NOW,
    });
    expect(r.phase).toBe("ready");
    expect(r.canSelfCheckIn).toBe(true);
    expect(r.gate).toBe("physical-lanes-closed");
    expect(r.laneNumbers).toEqual([12, 13]);
  });

  it("stays shut OUTSIDE the window, however idle the hardware looks", () => {
    // An idle lane an hour before a booking is somebody else's lane between games.
    const r = resolveLanePhase({
      lanes: confirmed,
      physicalLanes: [pl(12, "Closed"), pl(13, "Closed")],
      bookedAtMs: at(SELF_SERVICE_WINDOW_MINS + 1),
      nowMs: NOW,
    });
    expect(r.phase).toBe("not_ready");
    expect(r.canSelfCheckIn).toBe(false);
  });

  it("opens exactly ON the window boundary", () => {
    const r = resolveLanePhase({
      lanes: confirmed,
      physicalLanes: [pl(12, "Closed"), pl(13, "Closed")],
      bookedAtMs: at(SELF_SERVICE_WINDOW_MINS),
      nowMs: NOW,
    });
    expect(r.canSelfCheckIn).toBe(true);
  });

  it("stays open after the slot has started — a late guest can still check in", () => {
    const r = resolveLanePhase({
      lanes: confirmed,
      physicalLanes: [pl(12, "Closed"), pl(13, "Closed")],
      bookedAtMs: at(-40),
      nowMs: NOW,
    });
    expect(r.canSelfCheckIn).toBe(true);
  });

  it("ONE lane not Closed shuts the gate — a guest never gets a lane that isn't theirs", () => {
    for (const bad of ["Open", "Error", "None"] as const) {
      const r = resolveLanePhase({
        lanes: confirmed,
        physicalLanes: [pl(12, "Closed"), pl(13, bad)],
        bookedAtMs: at(5),
        nowMs: NOW,
      });
      expect(r.canSelfCheckIn, `lane 13 = ${bad}`).toBe(false);
      expect(r.phase).toBe("not_ready");
    }
  });

  it("shuts when the physical lanes could not be read at all", () => {
    // `listLanes` failing must not become an invitation. Empty means unknown, and
    // unknown is not ready.
    const r = resolveLanePhase({
      lanes: confirmed,
      physicalLanes: [],
      bookedAtMs: at(5),
      nowMs: NOW,
    });
    expect(r.canSelfCheckIn).toBe(false);
  });

  it("shuts when an assigned lane is missing from the physical list", () => {
    // Lane 13 assigned but absent from listLanes: we cannot say it is free.
    const r = resolveLanePhase({
      lanes: confirmed,
      physicalLanes: [pl(12, "Closed")],
      bookedAtMs: at(5),
      nowMs: NOW,
    });
    expect(r.canSelfCheckIn).toBe(false);
  });

  it("shuts with no booked time to measure the window against", () => {
    const r = resolveLanePhase({
      lanes: confirmed,
      physicalLanes: [pl(12, "Closed"), pl(13, "Closed")],
      bookedAtMs: 0,
      nowMs: NOW,
    });
    expect(r.canSelfCheckIn).toBe(false);
  });

  it("ignores Temporary/None booked lanes with no lane number", () => {
    const r = resolveLanePhase({
      lanes: [{ ...bl(0, "Temporary"), LaneNumber: 0 }],
      physicalLanes: [pl(12, "Closed")],
      bookedAtMs: at(5),
      nowMs: NOW,
    });
    expect(r.laneNumbers).toEqual([]);
    expect(r.canSelfCheckIn).toBe(false);
  });
});

describe("laneLabel", () => {
  it("reads as one lane or several", () => {
    expect(laneLabel([])).toBe("");
    expect(laneLabel([12])).toBe("Lane 12");
    expect(laneLabel([12, 13])).toBe("Lanes 12, 13");
  });
});
