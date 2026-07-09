import { describe, expect, it } from "vitest";
import {
  raceSettleGate,
  resolveRaceLiveState,
  trackKeyFromName,
  type SettleHeat,
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

describe("raceSettleGate", () => {
  // July = EDT (UTC-4): heat "17:24" ET starts 21:24Z. NOW helpers below are
  // real epoch ms, matching the cron's Date.now().
  const at = (utcIso: string) => Date.parse(utcIso);
  const TODAY = "2026-07-08";
  const HEAT_A: SettleHeat = { startIso: "2026-07-08T17:24:00", track: "Blue Track" };
  const HEAT_B: SettleHeat = { startIso: "2026-07-08T19:24:00", track: "Blue Track" };

  /** Blue sessions covering both heats; per-heat actual* via overrides. */
  function blue(
    a?: Partial<TrackSession>,
    b?: Partial<TrackSession>,
  ): Partial<Record<"blue" | "red" | "mega", TrackSession[]>> {
    return {
      blue: [
        {
          sessionId: "101",
          scheduledStart: "2026-07-08T21:24:00.000Z",
          heatNumber: 35,
          actualStart: null,
          actualEnd: null,
          ...a,
        },
        {
          sessionId: "102",
          scheduledStart: "2026-07-08T23:24:00.000Z",
          heatNumber: 45,
          actualStart: null,
          actualEnd: null,
          ...b,
        },
      ],
    };
  }
  const FINISHED_A = { actualStart: "2026-07-08T21:46:00Z", actualEnd: "2026-07-08T21:55:00Z" };
  const FINISHED_B = { actualStart: "2026-07-08T23:40:00Z", actualEnd: "2026-07-08T23:49:00Z" };

  function gate(args: {
    heats: SettleHeat[];
    sessions?: Partial<Record<"blue" | "red" | "mega", TrackSession[]>>;
    nowMs: number;
  }) {
    return raceSettleGate({
      heats: args.heats,
      sessionsByTrack: args.sessions ?? {},
      watermarks: {},
      nowMs: args.nowMs,
      todayEtYmd: TODAY,
    });
  }

  it("all heats finished → eligible, race-finished", () => {
    const g = gate({
      heats: [HEAT_A, HEAT_B],
      sessions: blue(FINISHED_A, FINISHED_B),
      nowMs: at("2026-07-08T23:55:00Z"),
    });
    expect(g).toEqual({ eligible: true, reason: "race-finished" });
  });

  it("first finished + second still on track → waits, even past the 45m net (truth wins)", () => {
    const g = gate({
      heats: [HEAT_A, HEAT_B],
      sessions: blue(FINISHED_A, { actualStart: "2026-07-09T00:15:00Z" }),
      // 19:24 ET heat +50 min = 00:14Z next day — past the grace, still waits.
      nowMs: at("2026-07-09T00:16:00Z"),
    });
    expect(g.eligible).toBe(false);
    expect(g.reason).toContain("on_track");
  });

  it("not-yet-called second heat waits too", () => {
    const g = gate({
      heats: [HEAT_A, HEAT_B],
      sessions: blue(FINISHED_A, {}),
      nowMs: at("2026-07-09T00:16:00Z"),
    });
    expect(g.eligible).toBe(false);
    expect(g.reason).toContain("not_called");
  });

  it("unresolvable heat: waits inside 45m, clock-settles after", () => {
    // No sessions at all — e.g. Pandora outage / reschedule drift.
    const early = gate({ heats: [HEAT_A], nowMs: at("2026-07-08T21:50:00Z") }); // +26m
    expect(early.eligible).toBe(false);
    expect(early.reason).toContain("unresolved");
    const late = gate({ heats: [HEAT_A], nowMs: at("2026-07-08T22:10:00Z") }); // +46m
    expect(late).toEqual({ eligible: true, reason: "clock-45m" });
  });

  it("mixed: resolved-finished + unresolvable past 45m → eligible via clock-45m", () => {
    const noSecondSession = { blue: blue(FINISHED_A).blue!.slice(0, 1) };
    const g = gate({
      heats: [HEAT_A, HEAT_B],
      sessions: noSecondSession,
      nowMs: at("2026-07-09T00:16:00Z"), // second heat +52m, unresolved
    });
    expect(g).toEqual({ eligible: true, reason: "clock-45m" });
  });

  it("heat dated yesterday settles immediately (Pandora is same-day only)", () => {
    const g = gate({
      heats: [{ startIso: "2026-07-07T19:24:00", track: "Blue Track" }],
      nowMs: at("2026-07-08T15:00:00Z"),
    });
    expect(g).toEqual({ eligible: true, reason: "clock-past-date" });
  });

  it("resolved session that never finishes force-settles at the +6h hard cap", () => {
    const sessions = blue({ actualStart: "2026-07-08T21:46:00Z" }); // A on_track forever
    const before = gate({ heats: [HEAT_A], sessions, nowMs: at("2026-07-09T03:20:00Z") }); // +5h56m
    expect(before.eligible).toBe(false);
    const after = gate({ heats: [HEAT_A], sessions, nowMs: at("2026-07-09T03:30:00Z") }); // +6h06m
    expect(after).toEqual({ eligible: true, reason: "clock-hardcap" });
  });

  it("no heats recorded → not eligible (route keeps -5-only behavior)", () => {
    const g = gate({ heats: [], nowMs: at("2026-07-08T23:55:00Z") });
    expect(g.eligible).toBe(false);
    expect(g.reason).toBe("no heats recorded");
  });
});
