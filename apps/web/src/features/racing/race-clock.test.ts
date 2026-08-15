import { describe, it, expect } from "vitest";
import {
  emptyClock,
  remainingMs,
  displayRemainingMs,
  formatClock,
  measuredExcessMs,
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

/** Arm then green — the venue's two-phase start, which every real race does.
 *  Returns a clock whose countdown is anchored at `green`. */
function started(green: number, over: Partial<ReturnType<typeof baseRec>> = {}) {
  const armed = applyRaceStart(emptyClock("1", START), rec(over), START);
  return applyRaceStart(armed, rec(over), green);
}

describe("remainingMs", () => {
  it("counts down in real time on a clean race", () => {
    const c = started(START);
    expect(remainingMs(c, START)).toBe(420_000);
    expect(remainingMs(c, START + 60_000)).toBe(360_000);
    expect(remainingMs(c, START + 420_000)).toBe(0);
  });

  it("goes negative when a race runs over, rather than clamping", () => {
    // Ops needs to see an overrun; only the display helper clamps.
    const c = started(START);
    expect(remainingMs(c, START + 500_000)).toBe(-80_000);
    expect(displayRemainingMs(c, START + 500_000)).toBe(0);
  });

  it("is null, not zero, when the record is incomplete", () => {
    // The exact failure mode the vendor's TimeLeftMs has.
    const c = emptyClock("1", START);
    expect(remainingMs(c, START)).toBeNull();
    const noDuration = started(START, { durationMs: null });
    expect(remainingMs(noDuration, START)).toBeNull();
  });

  it("FREEZES while paused", () => {
    const c = started(START);
    const paused = applyRaceStop(c, rec({ state: "Paused" }), START + 120_000);
    // 2 min in, 5 min left — and it stays 5 min however long the pause runs.
    expect(remainingMs(paused, START + 120_000)).toBe(300_000);
    expect(remainingMs(paused, START + 600_000)).toBe(300_000);
    expect(remainingMs(paused, START + 3_600_000)).toBe(300_000);
  });

  it("resumes from where it froze", () => {
    let c = started(START);
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
    let c = started(START);
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
    const c = started(START);
    expect(remainingMs(c, START + 360_000)).toBe(60_000); // 1 min left
    const extended = applyDurationChange(
      c,
      { raceId: "1", sessionName: "66 - Blue Starter", durationMs: 16 * 60_000, atMs: START },
      START + 360_000,
    );
    expect(remainingMs(extended, START + 360_000)).toBe(600_000); // now 10 min
  });

  it("ignores an unparseable duration rather than blanking the clock", () => {
    const c = started(START);
    const same = applyDurationChange(
      c,
      { raceId: "1", sessionName: "x", durationMs: null, atMs: START },
      START + 1000,
    );
    expect(same.durationMs).toBe(420_000);
  });
});

describe("measuredExcessMs — total non-racing time, NOT the pause", () => {
  it("measures race 58698117's 9:23 of non-racing time", () => {
    // Real numbers off the wire 2026-08-15: started 00:46:01.0616,
    // ended 01:48:24.398, duration 00:53:00. Wall span 62:23 - 53:00 = 9:23.
    // NOT pure pause: it also contains the arm->green gap at the front and the
    // pending-finish window at the tail.
    const start = ET("2026-08-15T00:46:01.061");
    const end = ET("2026-08-15T01:48:24.398");
    const pause = measuredExcessMs({
      actualStartMs: start,
      actualEndMs: end,
      durationMs: 53 * 60_000,
    });
    expect(pause).not.toBeNull();
    expect(Math.round(pause! / 1000)).toBe(563); // 9:23
  });

  it("never returns a negative pause for a race that ended early", () => {
    expect(
      measuredExcessMs({ actualStartMs: START, actualEndMs: START + 60_000, durationMs: 420_000 }),
    ).toBe(0);
  });
});

describe("the two-phase start", () => {
  // Race 55884963 "16 - Blue Starter", captured off the wire 2026-08-15.
  const ARM = Date.parse("2026-08-15T16:13:38.013Z");
  const GREEN = Date.parse("2026-08-15T16:14:53.807Z"); // +75.8s, rv bump only
  const PAUSE_AT = Date.parse("2026-08-15T16:20:52.224Z");
  const RESUME_AT = Date.parse("2026-08-15T16:22:38.785Z"); // +106.6s
  const FINISH_AT = Date.parse("2026-08-15T16:23:42.271Z"); // unstamped Finished
  const SEVEN = 7 * 60_000;
  // ActualStart is stamped at the ARM and never moves — the crux of the bug.
  const wire = (over = {}) => rec({ actualStartMs: ARM - 1475, durationMs: SEVEN, ...over });

  it("does NOT start counting on the first RaceStart", () => {
    const c = applyRaceStart(emptyClock("55884963", ARM), wire(), ARM);
    expect(c.phase).toBe("armed");
    expect(c.clockStartMs).toBeNull();
    // Armed reads the full race length, static — what the venue's screens show.
    expect(remainingMs(c, ARM)).toBe(SEVEN);
    expect(remainingMs(c, ARM + 60_000)).toBe(SEVEN);
  });

  it("anchors on the SECOND RaceStart, and predicts the real finish to ~2s", () => {
    let c = applyRaceStart(emptyClock("55884963", ARM), wire(), ARM);
    c = applyRaceStart(c, wire(), GREEN);
    expect(c.phase).toBe("running");
    expect(c.clockStartMs).toBe(GREEN);
    expect(c.anchorEstimated).toBe(false);

    c = applyRaceStop(c, wire({ state: "Paused" }), PAUSE_AT);
    c = applyRaceStart(c, wire(), RESUME_AT);
    expect(Math.round(c.pausedTotalMs / 1000)).toBe(107);

    // THE CHECK: the clock should hit zero when the venue said the race ended.
    const zeroAt = GREEN + SEVEN + c.pausedTotalMs;
    expect(Math.abs(zeroAt - FINISH_AT)).toBeLessThan(2500);

    // Anchoring on ActualStart instead — the old bug — is out by ~76s.
    const wrong = ARM - 1475 + SEVEN + c.pausedTotalMs;
    expect(FINISH_AT - wrong).toBeGreaterThan(70_000);
  });

  it("treats a repeated start while running as a no-op, not a re-anchor", () => {
    // The snapshot resends constantly; re-anchoring would rewind the countdown.
    let c = applyRaceStart(emptyClock("1", ARM), wire(), ARM);
    c = applyRaceStart(c, wire(), GREEN);
    for (let i = 1; i <= 5; i++) c = applyRaceStart(c, wire(), GREEN + i * 1000);
    expect(c.clockStartMs).toBe(GREEN);
  });

  it("a stop BEFORE the green does not become a pause", () => {
    // Otherwise the next start reads as a resume and the clock never anchors.
    let c = applyRaceStart(emptyClock("1", ARM), wire(), ARM);
    c = applyRaceStop(c, wire({ state: "Paused" }), ARM + 10_000);
    expect(c.phase).toBe("armed");
    expect(c.pausedSinceMs).toBeNull();
    c = applyRaceStart(c, wire(), GREEN);
    expect(c.phase).toBe("running");
    expect(c.clockStartMs).toBe(GREEN);
  });

  it("falls back to ActualStart when we join mid-race", () => {
    // Bridge restart: the catch-up dump replays an in-flight race as a plain
    // Started record with no phase-two bump to follow. Holding it armed forever
    // would mean never showing a clock at all.
    const longAgo = START - 10 * 60_000;
    const c = applyRaceStart(emptyClock("9", START), rec({ actualStartMs: longAgo }), START);
    expect(c.phase).toBe("running");
    expect(c.clockStartMs).toBe(longAgo);
    expect(c.anchorEstimated).toBe(true);
  });
});

describe("applyRaceFinish", () => {
  it("keeps the ACCRUED pause rather than the end-minus-start excess", () => {
    // (end - start) - duration is arm-gap + pause + pending-finish tail, not
    // pause. Overwriting our honest accrual with it was wrong.
    let c = started(START);
    c = applyRaceStop(c, rec({ state: "Paused" }), START + 60_000);
    c = applyRaceStart(c, rec(), START + 120_000);
    expect(c.pausedTotalMs).toBe(60_000);
    const end = START + 62 * 60_000 + 23_000;
    c = applyRaceFinish(
      c,
      rec({ state: "Finished", actualEndMs: end, durationMs: 53 * 60_000 }),
      end,
    );
    expect(c.phase).toBe("finished");
    expect(c.pausedTotalMs).toBe(60_000);
    expect(remainingMs(c, end)).toBe(0);
  });

  it("closes a pause that was still open at the flag", () => {
    let c = started(START);
    c = applyRaceStop(c, rec({ state: "Paused" }), START + 60_000);
    c = applyRaceFinish(c, rec({ state: "Finished" }), START + 90_000);
    expect(c.pausedSinceMs).toBeNull();
    expect(c.pausedTotalMs).toBe(30_000);
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

  it("replays a real race: arm, green, pause, resume, time-add, finish", () => {
    const clocks = new Map();
    const t0 = ET("2026-08-15T00:46:01.061");
    const green = t0 + 76_000; // the venue's arm->green gap, measured

    // ARM — staged, clock parked at the full length.
    foldMessageIntoClocks(clocks, [raceStart], t0);
    expect(clocks.get("58698117")!.phase).toBe("armed");
    expect(remainingMs(clocks.get("58698117")!, t0 + 30_000)).toBe(420_000);

    // GREEN — the second RaceStart. Only now does it count.
    foldMessageIntoClocks(clocks, [raceStart], green);
    expect(clocks.get("58698117")!.phase).toBe("running");
    expect(remainingMs(clocks.get("58698117")!, green)).toBe(420_000);
    expect(remainingMs(clocks.get("58698117")!, green + 60_000)).toBe(360_000);

    // Paused five minutes in, resumed nine minutes later.
    foldMessageIntoClocks(clocks, [raceStop], green + 300_000);
    expect(clocks.get("58698117")!.phase).toBe("paused");
    expect(remainingMs(clocks.get("58698117")!, green + 800_000)).toBe(120_000); // frozen

    foldMessageIntoClocks(clocks, [raceStart], green + 840_000);
    expect(clocks.get("58698117")!.pausedTotalMs).toBe(540_000);
    expect(remainingMs(clocks.get("58698117")!, green + 840_000)).toBe(120_000);

    // Staff push it out to 53 minutes.
    foldMessageIntoClocks(clocks, [durationChange], green + 900_000);
    expect(clocks.get("58698117")!.durationMs).toBe(3_180_000);

    // Finish keeps our accrued pause; the end stamp does not redefine it.
    foldMessageIntoClocks(clocks, [raceFinish], ET("2026-08-15T01:48:24.398"));
    const done = clocks.get("58698117")!;
    expect(done.phase).toBe("finished");
    expect(done.pausedTotalMs).toBe(540_000);
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
    // The venue re-sends its whole list constantly. The first start arms, the
    // second is the green, and every repeat after that must be inert — a
    // re-anchor would rewind the countdown once per second, forever.
    const clocks = new Map();
    const t0 = ET("2026-08-15T00:46:01.061");
    for (let i = 0; i < 10; i++) foldMessageIntoClocks(clocks, [raceStart], t0 + i * 1000);
    const c = clocks.get("58698117")!;
    expect(c.pausedTotalMs).toBe(0);
    expect(c.clockStartMs).toBe(t0 + 1000); // the SECOND start, and only that one
    expect(remainingMs(c, t0 + 1000)).toBe(420_000);
    expect(remainingMs(c, t0 + 61_000)).toBe(360_000);
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
    const c = started(START);
    expect(isStale(c, START + 60 * 60_000)).toBe(false);
    expect(isStale(c, START + 120 * 60_000)).toBe(true);
  });
});
