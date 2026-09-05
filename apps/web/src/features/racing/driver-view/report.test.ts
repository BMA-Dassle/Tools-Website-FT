import { describe, expect, it } from "vitest";
import {
  buildReport,
  collapseIncidents,
  driverInReport,
  headline,
  levelUpFor,
  parseHeatNumber,
} from "./report";

const T = Date.parse("2026-09-05T03:30:00.000Z");

/** Blue heat 65 — kart 15's real laps, plus two invented rivals so the board
 *  has something to rank. Kart 15's times are verbatim from the queue. */
const CROSSINGS = [
  ...[null, null, 53419, 33881, 33761, 34608, 31208, 44469, 40768].map((ms, i) => ({
    kart: "15",
    participantName: "Eric Osborn",
    passingId: `a${i}`,
    lapTimeMs: ms,
    atUtc: new Date(T + i * 40_000).toISOString(),
  })),
  ...[32100, 30146, 31500].map((ms, i) => ({
    kart: "22",
    participantName: "Rival One",
    passingId: `b${i}`,
    lapTimeMs: ms,
    atUtc: new Date(T + i * 40_000).toISOString(),
  })),
];

const STANDINGS = [
  { name: "Rival One", kart: "22", bestMs: 30146, laps: 3, position: 1 },
  { name: "Eric Osborn", kart: "15", bestMs: 31208, laps: 9, position: 2 },
];

const EVENTS = [
  { eventId: "e1", kind: "blue", kart: "15", note: null, value: null, atMs: T + 60_000 },
  {
    eventId: "e2",
    kind: "personalBest",
    kart: "15",
    note: null,
    value: "31208",
    atMs: T + 240_000,
  },
  // Housekeeping must not reach a keepsake.
  { eventId: "e3", kind: "kartReassigned", kart: "15", note: null, value: null, atMs: T + 10 },
];

const REPORT = buildReport({
  sessionId: "58691643",
  sessionName: "65 - Blue Starter",
  track: "blue",
  standings: STANDINGS,
  crossings: CROSSINGS,
  events: EVENTS,
});

describe("buildReport", () => {
  it("takes the finishing order from the scoreboard, not from the laps", () => {
    // Kart 15 ran three times as many laps; the capture still says it was P2,
    // and the wall is what the guest saw.
    expect(REPORT.drivers.map((d) => d.kart)).toEqual(["22", "15"]);
    expect(REPORT.drivers[0].position).toBe(1);
  });

  it("attaches every crossing, rollout laps included", () => {
    const mine = driverInReport(REPORT, "15");
    expect(mine?.laps).toHaveLength(9);
    expect(mine?.summary.timed).toHaveLength(7);
    expect(mine?.summary.best?.lapTimeMs).toBe(31208);
  });

  it("finds the heat's fastest lap and the gap to it", () => {
    expect(REPORT.fastestLap).toEqual({ kart: "22", name: "Rival One", ms: 30146 });
    expect(driverInReport(REPORT, "15")?.gapToFastestMs).toBe(31208 - 30146);
    expect(driverInReport(REPORT, "22")?.gapToFastestMs).toBe(0);
  });

  it("measures consistency as the driver's own spread", () => {
    expect(driverInReport(REPORT, "15")?.consistencyMs).toBe(53419 - 31208);
  });

  it("keeps the flags worth remembering and drops the housekeeping", () => {
    const kinds = REPORT.timeline.map((e) => e.kind);
    expect(kinds).toContain("blue");
    expect(kinds).toContain("personalBest");
    expect(kinds).not.toContain("kartReassigned");
  });

  it("orders the timeline oldest first", () => {
    expect(REPORT.timeline[0].kind).toBe("blue");
  });

  it("keeps a driver whose laps we have but whose position we do not", () => {
    const r = buildReport({
      sessionId: "s",
      sessionName: null,
      track: null,
      standings: [],
      crossings: CROSSINGS,
      events: [],
    });
    // No capture at all — both karts still appear, unplaced.
    expect(r.drivers.map((d) => d.kart).sort()).toEqual(["15", "22"]);
    expect(r.drivers.every((d) => d.position === 0)).toBe(true);
  });

  it("marks a disqualification on the driver's line", () => {
    const r = buildReport({
      sessionId: "s",
      sessionName: "65 - Blue Starter",
      track: "blue",
      standings: STANDINGS,
      crossings: CROSSINGS,
      events: [
        { eventId: "d", kind: "disqualified", kart: "15", note: "test", value: null, atMs: T },
      ],
    });
    expect(driverInReport(r, "15")?.disqualified).toBe(true);
    expect(driverInReport(r, "22")?.disqualified).toBe(false);
  });

  it("spans the heat by its first and last crossing", () => {
    expect(REPORT.startedAtUtc).toBe(new Date(T).toISOString());
  });
});

describe("the numbers that tell a racer how to get faster", () => {
  const mine = driverInReport(REPORT, "15")!;

  it("measures repeatability against the MEDIAN lap, not the worst one", () => {
    // Timed laps: 53.419 33.881 33.761 34.608 31.208 44.469 40.768
    // sorted: 31.208 33.761 33.881 34.608 40.768 44.469 53.419 → median 34.608
    // Best-to-worst would be 22.211 — dominated by one bad lap and useless as
    // a measure of how they drive.
    expect(mine.medianGapMs).toBe(34608 - 31208);
    expect(mine.consistencyMs).toBe(53419 - 31208);
  });

  it("reports time found as first third against last third", () => {
    // 7 timed laps → thirds of 2. First two 53.419/33.881 (mean 43650),
    // last two 44.469/40.768 (mean 42619) → 1031ms found.
    expect(mine.improvementMs).toBe(43650 - 42619);
  });

  it("withholds a trend from too few laps", () => {
    const short = buildReport({
      sessionId: "s",
      sessionName: null,
      track: null,
      standings: [],
      crossings: CROSSINGS.filter((c) => c.kart === "22"), // 3 laps
      events: [],
    });
    expect(driverInReport(short, "22")?.improvementMs).toBeNull();
  });

  it("names the lap the best was set on", () => {
    expect(mine.bestLapNumber).toBe(7);
  });

  it("measures how close the field was, ignoring anyone with no time", () => {
    expect(REPORT.fieldSpreadMs).toBe(31208 - 30146);
  });

  it("names who found the most time, and nobody when nobody did", () => {
    // Only kart 15 has enough laps for a trend here.
    expect(REPORT.mostImproved?.kart).toBe("15");
    const flat = buildReport({
      sessionId: "s",
      sessionName: null,
      track: null,
      standings: [],
      crossings: CROSSINGS.filter((c) => c.kart === "22"),
      events: [],
    });
    expect(flat.mostImproved).toBeNull();
  });
});

describe("levelUpFor", () => {
  // Stub the cutoff lookup so this tests the SHAPE, not the numbers — the real
  // cutoffs live in ~/features/racing/qualify and are that module's to assert.
  const target = () => ({ level: "Intermediate", ms: 41_000 });

  it("says what to chase and how far off it is", () => {
    const lu = levelUpFor(REPORT, driverInReport(REPORT, "15")!, target);
    expect(lu?.level).toBe("Intermediate");
    expect(lu?.achieved).toBe(true); // 31.208 is already under 41s
    expect(lu?.gapMs).toBe(31208 - 41000);
  });

  it("shows a real gap when they are off the pace", () => {
    const slow = () => ({ level: "Pro", ms: 30_000 });
    const lu = levelUpFor(REPORT, driverInReport(REPORT, "15")!, slow);
    expect(lu?.achieved).toBe(false);
    expect(lu?.gapMs).toBe(31208 - 30000);
  });

  it("says nothing at the top of the ladder, or with no lap set", () => {
    expect(levelUpFor(REPORT, driverInReport(REPORT, "15")!, () => null)).toBeNull();
    const noLaps = {
      ...driverInReport(REPORT, "15")!,
      summary: { ...driverInReport(REPORT, "15")!.summary, best: null },
    };
    expect(levelUpFor(REPORT, noLaps, target)).toBeNull();
  });
});

describe("collapseIncidents", () => {
  const ev = (kind: string, kart: string | null, atMs: number, eventId: string) => ({
    eventId,
    kind,
    kart,
    note: null,
    value: null,
    atMs,
  });

  it("turns one kart's re-fired crash into a single line", () => {
    // The venue re-announces crash detect every second or two while a kart sits
    // stopped. This is what produced 2,239 rows in one session.
    const rows = Array.from({ length: 30 }, (_, i) => ev("crash", "6", T + i * 1500, `r${i}`));
    const out = collapseIncidents(rows);
    expect(out).toHaveLength(1);
    expect(out[0].eventId).toBe("r0");
  });

  it("keeps a genuinely separate incident later in the heat", () => {
    const out = collapseIncidents([
      ev("crash", "6", T, "a"),
      ev("crash", "6", T + 5_000, "b"),
      ev("crash", "6", T + 400_000, "c"),
    ]);
    expect(out.map((e) => e.eventId)).toEqual(["a", "c"]);
  });

  it("keeps a different kart's crash — that is a real fact about the race", () => {
    const out = collapseIncidents([
      ev("crash", "6", T, "a"),
      ev("crash", "28", T + 300, "b"),
      ev("crash", "6", T + 1_200, "c"),
    ]);
    expect(out.map((e) => e.eventId)).toEqual(["a", "b"]);
  });

  it("rolls the window so a long spin stays one line", () => {
    // Re-fires 60s apart for five minutes: still one incident, not five.
    const rows = Array.from({ length: 6 }, (_, i) => ev("caution", null, T + i * 60_000, `w${i}`));
    expect(collapseIncidents(rows)).toHaveLength(1);
  });

  it("never collapses a moment — only a track condition", () => {
    // Three personal bests in a row are three real things that happened.
    const out = collapseIncidents([
      ev("personalBest", "15", T, "p1"),
      ev("personalBest", "15", T + 1_000, "p2"),
      ev("blue", "15", T + 2_000, "b1"),
      ev("blue", "15", T + 3_000, "b2"),
    ]);
    expect(out).toHaveLength(4);
  });

  it("orders by time regardless of the order it was handed", () => {
    const out = collapseIncidents([
      ev("personalBest", "15", T + 5_000, "late"),
      ev("personalBest", "15", T, "early"),
    ]);
    expect(out.map((e) => e.eventId)).toEqual(["early", "late"]);
  });
});

describe("parseHeatNumber", () => {
  it("reads the venue's two shapes", () => {
    expect(parseHeatNumber("65 - Blue Starter")).toBe(65);
    expect(parseHeatNumber("[HEAT] 66 - Mega Pro")).toBe(66);
  });

  it("does not guess at a group event", () => {
    expect(parseHeatNumber("Smith Birthday Party")).toBeNull();
    expect(parseHeatNumber(null)).toBeNull();
  });
});

describe("headline", () => {
  it("opens a text with the place and the best lap", () => {
    expect(headline(REPORT, "15")).toBe("Heat 65: P2 of 2, best lap 31.208.");
  });

  it("leads with the disqualification when there is one", () => {
    const r = buildReport({
      sessionId: "s",
      sessionName: "65 - Blue Starter",
      track: "blue",
      standings: STANDINGS,
      crossings: CROSSINGS,
      events: [
        { eventId: "d", kind: "disqualified", kart: "15", note: null, value: null, atMs: T },
      ],
    });
    expect(headline(r, "15")).toBe("Heat 65: disqualified. Best lap 31.208.");
  });

  it("says something sane for a kart that is not in the heat", () => {
    expect(headline(REPORT, "99")).toBe("65 - Blue Starter — results");
  });
});
