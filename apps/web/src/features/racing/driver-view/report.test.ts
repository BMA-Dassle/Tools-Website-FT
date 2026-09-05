import { describe, expect, it } from "vitest";
import { buildReport, driverInReport, headline, parseHeatNumber } from "./report";

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
