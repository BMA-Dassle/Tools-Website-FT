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
  // 12-min grid anchored so heat 35 falls at 21:24Z — bulk-created sessions
  // have schedule order matching heat-number order (only staff INSERTS break
  // that, covered by the dedicated fixture below).
  const start = new Date(Date.parse("2026-07-08T14:24:00.000Z") + p.heatNumber * 12 * 60_000);
  return {
    sessionId: `5417${1700 + p.heatNumber}`,
    scheduledStart: start.toISOString(),
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

  it("watermark past an UNRUN heat → called, never finished (call-ahead regression)", () => {
    // Live 2026-07-10 8:07 PM: races/current called heat 47 while heat 45 was
    // still racing and 46 had actualStart=null — the grid call runs 1-2 heats
    // ahead of the track. The old watermarkPast inference marked two 8:00 PM
    // combos Done for heats that hadn't run. Calls are strictly ordered, so a
    // passed watermark means this heat's call already went out — it's CALLED
    // (racing within ~30 min of a call is normal), not done and not delayed.
    const watermark: TrackWatermark = {
      sessionId: 54171736,
      heatNumber: 36,
      calledAt: new Date(NOW - 2 * 60_000).toISOString(),
    };
    const r = resolveRaceLiveState({
      heatStartIso: HEAT_ET,
      sessions: base(),
      watermark,
      nowMs: NOW,
    });
    expect(r?.raceState).toBe("called");
  });

  it("watermark past an unrun heat, track stalled >30 min → not_called (real delay)", () => {
    // The latest call on the WHOLE track is >30 min old and this heat still
    // hasn't run — that's a genuine delay, not normal call-ahead flow.
    const watermark: TrackWatermark = {
      sessionId: 54171736,
      heatNumber: 36,
      calledAt: new Date(NOW - 35 * 60_000).toISOString(),
    };
    const r = resolveRaceLiveState({
      heatStartIso: HEAT_ET,
      sessions: base(),
      watermark,
      nowMs: NOW,
    });
    expect(r?.raceState).toBe("not_called");
  });

  it("watermark past an ON-TRACK heat → on_track, never finished (call-ahead regression)", () => {
    // Same night: Blue heat 46 went on track at 8:11 PM with the watermark
    // already at 47 — the old inference hid a live race behind "finished".
    const watermark: TrackWatermark = {
      sessionId: 54171736,
      heatNumber: 36,
      calledAt: new Date(NOW - 2 * 60_000).toISOString(),
    };
    const r = resolveRaceLiveState({
      heatStartIso: HEAT_ET,
      sessions: base({ actualStart: "2026-07-08T21:46:00Z" }),
      watermark,
      nowMs: NOW,
    });
    expect(r?.raceState).toBe("on_track");
  });

  it("watermark == this session within the 30-min window → called", () => {
    const watermark: TrackWatermark = {
      sessionId: 54171735, // number per races/current — resolved in the list as a string
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

  it("stale call (>30 min) no longer counts as called", () => {
    const watermark: TrackWatermark = {
      sessionId: 54171735,
      heatNumber: 35,
      calledAt: new Date(NOW - 35 * 60_000).toISOString(),
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

  describe("staff-inserted session (creation-order heatNumber, live 2026-07-11)", () => {
    // "76 - Blue Junior Starter" was inserted at 7:06 PM between heats 51 and
    // 52 and got the day-max number. Once it ran (7:41 PM), number-ordered
    // laterHeatRan flipped every unrun Blue heat — including the 10:36 PM
    // Intermediate (heat 69) — to "finished" on the board, and the settle
    // gate would have charged those bills hours early. Ordering must follow
    // scheduledStart, never heatNumber. Times below are the real payload
    // (July = EDT = UTC-4; now = 7:44 PM ET).
    const INSERTED_NOW = Date.parse("2026-07-11T23:44:00Z");
    const inserted = (p?: { calledWm?: boolean }): TrackSession[] => [
      {
        sessionId: "53945185",
        scheduledStart: "2026-07-11T22:59:00Z", // 6:59 PM ET, heat 51
        heatNumber: 51,
        actualStart: "2026-07-11T23:31:00Z",
        actualEnd: "2026-07-11T23:39:00Z",
      },
      {
        sessionId: "54604200",
        scheduledStart: "2026-07-11T23:06:00Z", // 7:06 PM ET — the insert
        heatNumber: 76,
        actualStart: "2026-07-11T23:41:00Z",
        actualEnd: null,
      },
      {
        sessionId: "53945187",
        scheduledStart: "2026-07-11T23:13:00Z", // 7:13 PM ET, heat 52, unrun
        heatNumber: 52,
        actualStart: null,
        actualEnd: null,
      },
      {
        sessionId: "53945221",
        scheduledStart: "2026-07-12T02:36:00Z", // 10:36 PM ET, heat 69, unrun
        heatNumber: 69,
        actualStart: null,
        actualEnd: null,
      },
    ];

    it("its run never finishes a later-scheduled unrun heat (the 10:36 PM Done bug)", () => {
      const r = resolveRaceLiveState({
        heatStartIso: "2026-07-11T22:36:00",
        sessions: inserted(),
        nowMs: INSERTED_NOW,
      });
      expect(r).toMatchObject({ heatNumber: 69, raceState: "not_called" });
    });

    it("nor the next regular heat right behind it", () => {
      // Heat 52 (7:13 PM) is scheduled AFTER the insert (7:06 PM) — the
      // insert running says nothing about 52.
      const r = resolveRaceLiveState({
        heatStartIso: "2026-07-11T19:13:00",
        sessions: inserted(),
        nowMs: INSERTED_NOW,
      });
      expect(r).toMatchObject({ heatNumber: 52, raceState: "not_called" });
    });

    it("but a heat scheduled BEFORE the insert is finished by its run (orphan guard intact)", () => {
      // Strip heat 51's own actualEnd — the insert (7:06 PM) starting still
      // proves the 6:59 PM heat is over.
      const sessions = inserted();
      sessions[0] = { ...sessions[0], actualEnd: null };
      const r = resolveRaceLiveState({
        heatStartIso: "2026-07-11T18:59:00",
        sessions,
        nowMs: INSERTED_NOW,
      });
      expect(r).toMatchObject({ heatNumber: 51, raceState: "finished" });
    });

    it("a watermark ON the insert does not mark later-scheduled heats called", () => {
      // The 7:06 PM insert's call (heat 76) went out — that says nothing
      // about the 10:36 PM heat 69. Number order would have said "called".
      const watermark: TrackWatermark = {
        sessionId: 54604200,
        heatNumber: 76,
        calledAt: new Date(INSERTED_NOW - 4 * 60_000).toISOString(),
      };
      const r = resolveRaceLiveState({
        heatStartIso: "2026-07-11T22:36:00",
        sessions: inserted(),
        watermark,
        nowMs: INSERTED_NOW,
      });
      expect(r?.raceState).toBe("not_called");
    });

    it("a watermark on the insert DOES mark earlier-scheduled heats called", () => {
      // Calls are strictly schedule-ordered: the 7:06 PM insert being called
      // means the unrun 6:59 PM heat's call already went out.
      const sessions = inserted();
      sessions[0] = { ...sessions[0], actualStart: null, actualEnd: null };
      sessions[1] = { ...sessions[1], actualStart: null };
      const watermark: TrackWatermark = {
        sessionId: 54604200,
        heatNumber: 76,
        calledAt: new Date(INSERTED_NOW - 4 * 60_000).toISOString(),
      };
      const r = resolveRaceLiveState({
        heatStartIso: "2026-07-11T18:59:00",
        sessions,
        watermark,
        nowMs: INSERTED_NOW,
      });
      expect(r?.raceState).toBe("called");
    });
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

  it("watermark past an unrun heat does NOT settle it (call-ahead regression)", () => {
    // 2026-07-10: the grid call moved past heat 46 while it still hadn't run.
    // The old watermarkPast→finished inference would have charged the bill
    // ~10-20 min before the race actually happened.
    const g = raceSettleGate({
      heats: [HEAT_B],
      sessionsByTrack: blue(FINISHED_A, {}),
      watermarks: { blue: { sessionId: 999, heatNumber: 47, calledAt: "2026-07-09T00:10:00Z" } },
      nowMs: at("2026-07-09T00:16:00Z"), // +52m past scheduled start — grace does not apply, heat resolves
      todayEtYmd: TODAY,
    });
    expect(g.eligible).toBe(false);
    // Recent call (<30 min) + watermark past ⇒ the heat is CALLED and about
    // to run — the gate waits for it, it never charges early.
    expect(g.reason).toContain("heat called");
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
