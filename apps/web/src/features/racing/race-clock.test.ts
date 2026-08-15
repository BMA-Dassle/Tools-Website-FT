import { describe, it, expect } from "vitest";
import {
  emptyClock,
  remainingMs,
  displayRemainingMs,
  formatClock,
  measuredPauseMs,
  applyRaceStart,
  applyRaceStop,
  applyRaceFinish,
  applyDurationChange,
  foldMessageIntoClocks,
  isStale,
} from "./race-clock";
import {
  extractRaceStops,
  extractDurationChanges,
  extractRaceStarts,
  parseVenueDurationMs,
} from "./venue-broadcast";

/** Venue-local ET wall clock → the epoch ms the parser will produce. Written
 *  the long way so the tests read in the venue's own timezone, like the wire. */
const ET = (iso: string) => Date.parse(`${iso}-04:00`); // Aug = EDT

const START = ET("2026-08-15T00:46:01.061");

function rec(over: Partial<ReturnType<typeof baseRec>> = {}) {
  return { ...baseRec(), ...over };
}
function baseRec() {
  return {
    raceId: "58698117",
    heatName: "66 - Blue Starter",
    heatNumber: 66,
    track: "blue" as const,
    state: "Started",
    actualStartMs: START as number | null,
    actualEndMs: null as number | null,
    durationMs: (7 * 60_000) as number | null,
  };
}

describe("parseVenueDurationMs", () => {
  it("accepts both widths the venue actually sends", () => {
    // Race records use "00:07:00"; duration-change notifications use "0:16:00".
    expect(parseVenueDurationMs("00:07:00")).toBe(420_000);
    expect(parseVenueDurationMs("0:16:00")).toBe(960_000);
    expect(parseVenueDurationMs("00:53:00")).toBe(3_180_000);
  });

  it("is null — never zero — for anything it cannot read", () => {
    // Zero would render as "no time left" on a wall, which is a lie.
    for (const bad of [undefined, null, "", "7 minutes", "1:2:3:4", "00:60:00", 420000]) {
      expect(parseVenueDurationMs(bad)).toBeNull();
    }
  });
});

describe("remainingMs", () => {
  it("counts down in real time on a clean race", () => {
    const c = applyRaceStart(emptyClock("1", START), rec(), START);
    expect(remainingMs(c, START)).toBe(420_000);
    expect(remainingMs(c, START + 60_000)).toBe(360_000);
    expect(remainingMs(c, START + 420_000)).toBe(0);
  });

  it("goes negative when a race runs over, rather than clamping", () => {
    // Ops needs to see an overrun; only the display helper clamps.
    const c = applyRaceStart(emptyClock("1", START), rec(), START);
    expect(remainingMs(c, START + 500_000)).toBe(-80_000);
    expect(displayRemainingMs(c, START + 500_000)).toBe(0);
  });

  it("is null, not zero, when the record is incomplete", () => {
    // The exact failure mode the vendor's TimeLeftMs has.
    const c = emptyClock("1", START);
    expect(remainingMs(c, START)).toBeNull();
    const noDuration = applyRaceStart(c, rec({ durationMs: null }), START);
    expect(remainingMs(noDuration, START)).toBeNull();
  });

  it("FREEZES while paused", () => {
    const c = applyRaceStart(emptyClock("1", START), rec(), START);
    const paused = applyRaceStop(c, rec({ state: "Paused" }), START + 120_000);
    // 2 min in, 5 min left — and it stays 5 min however long the pause runs.
    expect(remainingMs(paused, START + 120_000)).toBe(300_000);
    expect(remainingMs(paused, START + 600_000)).toBe(300_000);
    expect(remainingMs(paused, START + 3_600_000)).toBe(300_000);
  });

  it("resumes from where it froze", () => {
    let c = applyRaceStart(emptyClock("1", START), rec(), START);
    c = applyRaceStop(c, rec({ state: "Paused" }), START + 120_000);
    // Nine minutes of pause, then the venue re-sends RaceStart with the SAME
    // ActualStart — the behaviour that breaks naive start+duration math.
    c = applyRaceStart(c, rec(), START + 660_000);
    expect(c.pausedTotalMs).toBe(540_000);
    expect(remainingMs(c, START + 660_000)).toBe(300_000);
    expect(remainingMs(c, START + 720_000)).toBe(240_000);
  });

  it("does not restart the pause window when RaceStop repeats", () => {
    // The snapshot resends every second; a re-entrant stop must not collapse
    // the pause to nothing.
    let c = applyRaceStart(emptyClock("1", START), rec(), START);
    c = applyRaceStop(c, rec({ state: "Paused" }), START + 60_000);
    for (let i = 1; i <= 5; i++)
      c = applyRaceStop(c, rec({ state: "Paused" }), START + 60_000 + i * 1000);
    expect(c.pausedSinceMs).toBe(START + 60_000);
    c = applyRaceStart(c, rec(), START + 120_000);
    expect(c.pausedTotalMs).toBe(60_000);
  });
});

describe("staff time-adds", () => {
  it("extends the clock by the new TOTAL, not a delta", () => {
    const c = applyRaceStart(emptyClock("1", START), rec(), START);
    expect(remainingMs(c, START + 360_000)).toBe(60_000); // 1 min left
    const extended = applyDurationChange(
      c,
      { raceId: "1", sessionName: "66 - Blue Starter", durationMs: 16 * 60_000, atMs: START },
      START + 360_000,
    );
    expect(remainingMs(extended, START + 360_000)).toBe(600_000); // now 10 min
  });

  it("ignores an unparseable duration rather than blanking the clock", () => {
    const c = applyRaceStart(emptyClock("1", START), rec(), START);
    const same = applyDurationChange(
      c,
      { raceId: "1", sessionName: "x", durationMs: null, atMs: START },
      START + 1000,
    );
    expect(same.durationMs).toBe(420_000);
  });
});

describe("measuredPauseMs — the ground truth check", () => {
  it("reproduces race 58698117's exact 9:23 of pause", () => {
    // Real numbers off the wire 2026-08-15: started 00:46:01.0616,
    // ended 01:48:24.398, duration 00:53:00. Wall span 62:23 - 53:00 = 9:23.
    const start = ET("2026-08-15T00:46:01.061");
    const end = ET("2026-08-15T01:48:24.398");
    const pause = measuredPauseMs({
      actualStartMs: start,
      actualEndMs: end,
      durationMs: 53 * 60_000,
    });
    expect(pause).not.toBeNull();
    expect(Math.round(pause! / 1000)).toBe(563); // 9:23
  });

  it("never returns a negative pause for a race that ended early", () => {
    expect(
      measuredPauseMs({ actualStartMs: START, actualEndMs: START + 60_000, durationMs: 420_000 }),
    ).toBe(0);
  });
});

describe("applyRaceFinish", () => {
  it("prefers the measured pause over what we accrued", () => {
    // We were disconnected for part of the pause, so our accrual is short.
    let c = applyRaceStart(emptyClock("58698117", START), rec(), START);
    c = applyRaceStop(c, rec({ state: "Paused" }), START + 60_000);
    c = applyRaceStart(c, rec(), START + 120_000); // accrued only 1 min
    expect(c.pausedTotalMs).toBe(60_000);
    const end = START + 62 * 60_000 + 23_000;
    c = applyRaceFinish(
      c,
      rec({ state: "Finished", actualEndMs: end, durationMs: 53 * 60_000 }),
      end,
    );
    expect(c.phase).toBe("finished");
    expect(Math.round(c.pausedTotalMs / 1000)).toBe(563); // the true 9:23
    expect(remainingMs(c, end)).toBe(0);
  });
});

describe("wire extraction", () => {
  const snapshot = [
    {
      $type: "RaceStart",
      RaceId: 58698117,
      Name: "66 - Blue Starter",
      ResourceId: 11208654,
      State: "Started",
      ActualStart: "2026-08-15T00:46:01.0616",
      DurationTime: "00:53:00",
    },
    {
      $type: "RaceStop",
      RaceId: 58698117,
      Name: "66 - Blue Starter",
      ResourceId: 11208654,
      State: "Paused",
      ActualStart: "2026-08-15T00:46:01.0616",
      DurationTime: "00:53:00",
    },
    {
      $type: "SessionDurationChangedNotification",
      ResourceId: 11208660,
      SessionId: 58773798,
      SessionName: "65 - Red Starter Restarted",
      Mode: "AtMost",
      DurationTime: "0:16:00",
      Date: "2026-08-15T01:55:36.677",
    },
  ];

  it("pulls stops, starts and duration changes out of one snapshot", () => {
    expect(extractRaceStarts(snapshot)).toHaveLength(1);
    const stops = extractRaceStops(snapshot);
    expect(stops).toHaveLength(1);
    expect(stops[0].track).toBe("blue");
    expect(stops[0].durationMs).toBe(3_180_000);
  });

  it("reads SessionId as the race id, not RaceId", () => {
    // The notification uses a different field name for the same id space.
    const [change] = extractDurationChanges(snapshot);
    expect(change.raceId).toBe("58773798");
    expect(change.durationMs).toBe(960_000);
    expect(change.sessionName).toBe("65 - Red Starter Restarted");
  });

  it("keeps race ids as strings", () => {
    // House rule — same id space as Pandora sessionIds.
    expect(typeof extractRaceStarts(snapshot)[0].raceId).toBe("string");
    expect(extractRaceStarts(snapshot)[0].raceId).toBe("58698117");
  });
});

describe("foldMessageIntoClocks — the path the webhook actually runs", () => {
  // Records copied verbatim off the wire on 2026-08-15, ids and all.
  const raceStart = {
    $type: "RaceStart",
    RaceId: 58698117,
    Name: "66 - Blue Starter",
    ResourceId: 11208654,
    State: "Started",
    ActualStart: "2026-08-15T00:46:01.0616",
    DurationTime: "00:07:00",
  };
  const raceStop = { ...raceStart, $type: "RaceStop", State: "Paused" };
  const raceFinish = {
    ...raceStart,
    $type: "RaceFinish",
    State: "Finished",
    ActualEnd: "2026-08-15T01:48:24.398",
    DurationTime: "00:53:00",
  };
  const durationChange = {
    $type: "SessionDurationChangedNotification",
    ResourceId: 11208654,
    SessionId: 58698117,
    SessionName: "66 - Blue Starter",
    Mode: "AtMost",
    DurationTime: "0:53:00",
    Date: "2026-08-15T01:34:29.000",
  };

  it("replays a real race: start, pause, resume, time-add, finish", () => {
    const clocks = new Map();
    const t0 = ET("2026-08-15T00:46:01.061");

    foldMessageIntoClocks(clocks, [raceStart], t0);
    expect(remainingMs(clocks.get("58698117")!, t0)).toBe(420_000);

    // Paused seven minutes in, resumed nine minutes later.
    foldMessageIntoClocks(clocks, [raceStop], t0 + 300_000);
    expect(clocks.get("58698117")!.phase).toBe("paused");
    expect(remainingMs(clocks.get("58698117")!, t0 + 800_000)).toBe(120_000); // frozen

    foldMessageIntoClocks(clocks, [raceStart], t0 + 840_000);
    expect(clocks.get("58698117")!.pausedTotalMs).toBe(540_000);
    expect(remainingMs(clocks.get("58698117")!, t0 + 840_000)).toBe(120_000);

    // Staff push it out to 53 minutes.
    foldMessageIntoClocks(clocks, [durationChange], t0 + 900_000);
    expect(clocks.get("58698117")!.durationMs).toBe(3_180_000);

    // The real finish record closes it with the MEASURED pause.
    foldMessageIntoClocks(clocks, [raceFinish], ET("2026-08-15T01:48:24.398"));
    const done = clocks.get("58698117")!;
    expect(done.phase).toBe("finished");
    expect(Math.round(done.pausedTotalMs / 1000)).toBe(563); // 9:23, exactly
    expect(remainingMs(done, Date.now())).toBe(0);
  });

  it("handles the full 86-record snapshot shape without choking", () => {
    // The bridge forwards arrays; unrelated records must be ignored, not throw.
    const clocks = new Map();
    const snapshot = [
      raceStart,
      { $type: "BcTime", DateTime: "2026-08-15T01:30:53.4407541-04:00" },
      { $type: "RaceAdvice", RaceId: 58698117, Name: "66 - Blue Starter" },
      { $type: "PositioningGamificationRequest", Kind: "RacesStats", Content: "[]" },
      null,
      "not an object",
    ];
    const touched = foldMessageIntoClocks(clocks, snapshot, ET("2026-08-15T00:46:01.061"));
    expect([...touched]).toEqual(["58698117"]);
    expect(clocks.size).toBe(1);
  });

  it("tracks both tracks independently in one message", () => {
    const clocks = new Map();
    const red = {
      $type: "RaceStart",
      RaceId: 58773798,
      Name: "65 - Red Starter",
      ResourceId: 11208660,
      State: "Started",
      ActualStart: "2026-08-15T01:45:57.663",
      DurationTime: "00:07:00",
    };
    foldMessageIntoClocks(clocks, [raceStart, red], ET("2026-08-15T01:45:57.663"));
    expect(clocks.size).toBe(2);
    expect(clocks.get("58773798")!.track).toBe("red");
    expect(clocks.get("58698117")!.track).toBe("blue");
    // Red just started — a clean 7:00, which is the case we watched tick down.
    expect(remainingMs(clocks.get("58773798")!, ET("2026-08-15T01:45:57.663"))).toBe(420_000);
  });

  it("is idempotent against the snapshot repeating", () => {
    // The venue re-sends its whole list constantly; replaying must not drift.
    const clocks = new Map();
    const t0 = ET("2026-08-15T00:46:01.061");
    for (let i = 0; i < 10; i++) foldMessageIntoClocks(clocks, [raceStart], t0 + i * 1000);
    const c = clocks.get("58698117")!;
    expect(c.pausedTotalMs).toBe(0);
    expect(remainingMs(c, t0)).toBe(420_000);
  });
});

describe("formatting and staleness", () => {
  it("formats mm:ss and shows overruns as negative", () => {
    expect(formatClock(424_000)).toBe("7:04");
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(-12_000)).toBe("-0:12");
  });

  it("ages out a wedged race", () => {
    // One sat "Started" for 62 minutes on 8/15 with nothing on track.
    const c = applyRaceStart(emptyClock("1", START), rec(), START);
    expect(isStale(c, START + 60 * 60_000)).toBe(false);
    expect(isStale(c, START + 120 * 60_000)).toBe(true);
  });
});
