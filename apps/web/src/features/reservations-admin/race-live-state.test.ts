import { describe, expect, it } from "vitest";
import {
  resolveRaceLiveState,
  trackKeyFromName,
  type TrackSession,
  type TrackWatermark,
} from "./race-live-state";

/**
 * Fixtures mirror the live payload verified 2026-07-08: Pandora
 * scheduledStart/actual* are zoned UTC; our liveHeats starts are naive ET
 * (July = EDT = UTC-4, so 21:24Z == 17:24 ET wall).
 */

const NOW = Date.parse("2026-07-08T23:08:00.000Z");

function session(p: Partial<TrackSession> & { heatNumber: number }): TrackSession {
  const hh = String(13 + Math.floor((p.heatNumber * 12) / 60)).padStart(2, "0");
  const mm = String((p.heatNumber * 12) % 60).padStart(2, "0");
  return {
    sessionId: `5417${1700 + p.heatNumber}`,
    scheduledStart: `2026-07-08T${hh}:${mm}:00.000Z`,
    actualStart: null,
    actualEnd: null,
    ...p,
  };
}

describe("trackKeyFromName", () => {
  it("extracts the track from BMI line names and stored heat tracks", () => {
    expect(trackKeyFromName("Starter Race Blue")).toBe("blue");
    expect(trackKeyFromName("Intermediate Race Red")).toBe("red");
    expect(trackKeyFromName("Mega Track")).toBe("mega");
    expect(trackKeyFromName("Starter Race")).toBeNull();
    expect(trackKeyFromName(null)).toBeNull();
  });
});

describe("resolveRaceLiveState", () => {
  // Session scheduled 21:24Z == 5:24 PM ET wall — the naive liveHeats shape.
  const SCHEDULED_UTC = "2026-07-08T21:24:00.000Z";
  const HEAT_ET = "2026-07-08T17:24:00";

  function base(p?: Partial<TrackSession>): TrackSession[] {
    return [
      session({
        heatNumber: 34,
        actualStart: "2026-07-08T21:10:00Z",
        actualEnd: "2026-07-08T21:19:00Z",
      }),
      {
        ...session({ heatNumber: 35 }),
        scheduledStart: SCHEDULED_UTC,
        sessionId: "54171735",
        ...p,
      },
      session({ heatNumber: 36 }),
    ];
  }

  it("matches the session by start minute across the UTC↔naive-ET frames", () => {
    const r = resolveRaceLiveState({ heatStartIso: HEAT_ET, sessions: base(), nowMs: NOW });
    expect(r).toMatchObject({ sessionId: "54171735", heatNumber: 35 });
  });

  it("returns null when no session matches (reschedule drift / stale cache)", () => {
    const r = resolveRaceLiveState({
      heatStartIso: "2026-07-08T17:30:00",
      sessions: base(),
      nowMs: NOW,
    });
    expect(r).toBeNull();
  });

  it("actualEnd set → finished", () => {
    const r = resolveRaceLiveState({
      heatStartIso: HEAT_ET,
      sessions: base({ actualStart: "2026-07-08T21:46:00Z", actualEnd: "2026-07-08T21:55:00Z" }),
      nowMs: NOW,
    });
    expect(r?.raceState).toBe("finished");
  });

  it("actualStart only → on_track", () => {
    const r = resolveRaceLiveState({
      heatStartIso: HEAT_ET,
      sessions: base({ actualStart: "2026-07-08T21:46:00Z" }),
      nowMs: NOW,
    });
    expect(r?.raceState).toBe("on_track");
  });

  it("orphan guard: open session is finished once a LATER heat has started", () => {
    // The live 7/8 quirk — heat 35's actualEnd never stamped while 36 ran.
    const sessions = base({ actualStart: "2026-07-08T21:46:00Z" });
    sessions[2].actualStart = "2026-07-08T22:00:00Z";
    const r = resolveRaceLiveState({ heatStartIso: HEAT_ET, sessions, nowMs: NOW });
    expect(r?.raceState).toBe("finished");
  });

  it("watermark past the heat → finished even when actual* fields are absent (stale cache)", () => {
    const sessions = base();
    delete sessions[1].actualStart;
    delete sessions[1].actualEnd;
    const watermark: TrackWatermark = {
      sessionId: 54171736,
      heatNumber: 36,
      calledAt: "2026-07-08T22:30:00Z",
    };
    const r = resolveRaceLiveState({ heatStartIso: HEAT_ET, sessions, watermark, nowMs: NOW });
    expect(r?.raceState).toBe("finished");
  });

  it("watermark == this session within the 20-min window → called", () => {
    const watermark: TrackWatermark = {
      sessionId: 54171735, // number per races/current — string-compared
      heatNumber: 35,
      calledAt: new Date(NOW - 5 * 60_000).toISOString(),
    };
    const r = resolveRaceLiveState({
      heatStartIso: HEAT_ET,
      sessions: base(),
      watermark,
      nowMs: NOW,
    });
    expect(r?.raceState).toBe("called");
  });

  it("stale call (>20 min) no longer counts as called", () => {
    const watermark: TrackWatermark = {
      sessionId: 54171735,
      heatNumber: 35,
      calledAt: new Date(NOW - 25 * 60_000).toISOString(),
    };
    const r = resolveRaceLiveState({
      heatStartIso: HEAT_ET,
      sessions: base(),
      watermark,
      nowMs: NOW,
    });
    expect(r?.raceState).toBe("not_called");
  });

  it("no signals at all → not_called (the delayed-heat case)", () => {
    const r = resolveRaceLiveState({ heatStartIso: HEAT_ET, sessions: base(), nowMs: NOW });
    expect(r?.raceState).toBe("not_called");
  });
});
