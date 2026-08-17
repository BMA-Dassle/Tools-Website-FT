import { describe, expect, it } from "vitest";
import { extractLapPassings } from "./venue-broadcast";

/**
 * Fixtures are the REAL wire shape, copied from a live
 * `kart:events:queue` sample on 2026-08-17 — including the abbreviated
 * kiosk-typed name ("Genn A") and the fact that `PassingTimeUtc` carries a Z
 * while the venue's other stamps do not.
 */
const REAL = {
  $type: "TimingPassingNotification",
  LapTimeMs: 42084,
  PassingTimeUtc: "2026-08-17T03:24:25.618Z",
  PassingId: 58992702,
  RentalObjectId: 11230534,
  RentalObjectName: "27",
  TransponderCode: "25:04:67:3e:c5:f6",
  ParticipantId: 58964159,
  ParticipantName: "Genn A",
  SessionId: 58599025,
  SessionName: "60 - Blue Starter",
  NotificationMetaId: -149,
  ResourceId: 11208654,
  Id: 58992703,
  Date: "2026-08-16T23:24:25.789",
};

describe("extractLapPassings", () => {
  it("reads a real passing off the wire", () => {
    const [p] = extractLapPassings(REAL);
    expect(p).toEqual({
      sessionId: "58599025",
      sessionName: "60 - Blue Starter",
      participantName: "Genn A",
      kart: "27",
      lapTimeMs: 42084,
      passingAtMs: Date.parse("2026-08-17T03:24:25.618Z"),
      passingId: "58992702",
    });
  });

  it("parses PassingTimeUtc as a REAL UTC instant, not venue-local", () => {
    // The venue's ActualStart/ActualEnd are local wall clock with no zone; this
    // field is not. Routing it through that helper would shift it by 4 hours.
    const [p] = extractLapPassings(REAL);
    expect(new Date(p.passingAtMs).toISOString()).toBe("2026-08-17T03:24:25.618Z");
    // The record ALSO carries a local `Date` ("2026-08-16T23:24:25.789", no
    // zone) which is the same moment expressed in venue time. Reading that one
    // as if it were UTC — the mistake this test guards against — lands 4 hours
    // early, which would put the cut in a completely different race.
    const misreadAsUtc = Date.parse("2026-08-16T23:24:25.789Z");
    expect(p.passingAtMs - misreadAsUtc).toBeGreaterThan(3.9 * 3600_000);
    expect(p.passingAtMs - misreadAsUtc).toBeLessThan(4.1 * 3600_000);
  });

  it("locates the lap: it ENDS at the passing, having run LapTimeMs", () => {
    const [p] = extractLapPassings(REAL);
    const lapStart = p.passingAtMs - p.lapTimeMs;
    expect(new Date(lapStart).toISOString()).toBe("2026-08-17T03:23:43.534Z");
  });

  it("handles an array message and ignores other types alongside it", () => {
    const out = extractLapPassings([
      { $type: "SpeedChange", Karts: [], Speed: "Phase1" },
      REAL,
      { $type: "CrashNotification", RentalObjectName: "15" },
      { ...REAL, PassingId: 2, LapTimeMs: 39001, ParticipantName: "Other Racer" },
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.participantName)).toEqual(["Genn A", "Other Racer"]);
  });

  it("drops passings nothing could ever join to", () => {
    expect(extractLapPassings({ ...REAL, SessionId: null })).toHaveLength(0);
    expect(extractLapPassings({ ...REAL, ParticipantName: "   " })).toHaveLength(0);
    expect(extractLapPassings({ ...REAL, PassingTimeUtc: "not a date" })).toHaveLength(0);
  });

  it("drops the nonsense lap length an out lap arrives with", () => {
    expect(extractLapPassings({ ...REAL, LapTimeMs: 0 })).toHaveLength(0);
    expect(extractLapPassings({ ...REAL, LapTimeMs: -5 })).toHaveLength(0);
  });

  it("stringifies ids rather than Number()-ing them (house rule)", () => {
    const [p] = extractLapPassings(REAL);
    expect(p.sessionId).toBe("58599025");
    expect(typeof p.sessionId).toBe("string");
    expect(p.passingId).toBe("58992702");
  });

  it("survives junk without throwing — this rides the ingest hot path", () => {
    expect(extractLapPassings(null)).toEqual([]);
    expect(extractLapPassings("nope")).toEqual([]);
    expect(extractLapPassings([null, undefined, 42])).toEqual([]);
    expect(extractLapPassings({ $type: "RaceFinish", RaceId: 1 })).toEqual([]);
  });
});

/**
 * The reduction the store performs before writing. Kept as a pure expectation
 * here so the "keep the fastest, ignore the rest" rule is pinned even though the
 * write itself needs a database.
 */
describe("best-lap reduction", () => {
  function reduceToBest(passings: ReturnType<typeof extractLapPassings>) {
    const best = new Map<string, (typeof passings)[number]>();
    for (const p of passings) {
      const key = `${p.sessionId}::${p.participantName}`;
      const prev = best.get(key);
      if (!prev || p.lapTimeMs < prev.lapTimeMs) best.set(key, p);
    }
    return best;
  }

  it("keeps each racer's fastest lap and its own timestamp", () => {
    const laps = extractLapPassings([
      { ...REAL, LapTimeMs: 45000, PassingTimeUtc: "2026-08-17T03:20:00.000Z" },
      { ...REAL, LapTimeMs: 42084, PassingTimeUtc: "2026-08-17T03:24:25.618Z" },
      { ...REAL, LapTimeMs: 43500, PassingTimeUtc: "2026-08-17T03:25:10.000Z" },
    ]);
    const best = reduceToBest(laps);
    const row = best.get("58599025::Genn A")!;
    expect(row.lapTimeMs).toBe(42084);
    // The timestamp must be the FAST lap's, not the last one seen — otherwise
    // the cut lands on the wrong lap.
    expect(new Date(row.passingAtMs).toISOString()).toBe("2026-08-17T03:24:25.618Z");
  });

  it("is order-independent, so replays and catch-up dumps converge", () => {
    const forward = extractLapPassings([
      { ...REAL, LapTimeMs: 45000 },
      { ...REAL, LapTimeMs: 42084 },
    ]);
    const backward = extractLapPassings([
      { ...REAL, LapTimeMs: 42084 },
      { ...REAL, LapTimeMs: 45000 },
    ]);
    expect(reduceToBest(forward).get("58599025::Genn A")!.lapTimeMs).toBe(42084);
    expect(reduceToBest(backward).get("58599025::Genn A")!.lapTimeMs).toBe(42084);
  });

  it("separates racers who share a session", () => {
    const laps = extractLapPassings([
      { ...REAL, ParticipantName: "Genn A", LapTimeMs: 42084 },
      { ...REAL, ParticipantName: "Other Racer", LapTimeMs: 39001 },
    ]);
    expect(reduceToBest(laps).size).toBe(2);
  });
});
