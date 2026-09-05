import { describe, expect, it } from "vitest";
import { classify, parseEasternWallClock, readPassing, venueDateToMs } from "./classify";
import type { RoutingContext } from "./classify";

/**
 * REAL WIRE RECORDS, verbatim from `kart:events:queue` (32h survey, 2026-09-05).
 * The blue flag and the disqualification below are the owner's own test on Blue
 * heat 65 — kart 15, participant 60307227.
 */
const BLUE_FLAG = {
  $type: "ParticipantBlueFlagNotification",
  ResourceId: 11208654,
  SessionId: "58691643",
  SessionName: "65 - Blue Starter",
  ParticipantId: "60307227",
  ParticipantName: "Osborn",
  NotificationMetaId: -147,
  Tick: 0,
  Id: "60307804",
  Date: "2026-09-05T03:29:32.806",
};

const BLACK_WHITE = {
  $type: "ParticipantBlackOverWhiteFlagNotification",
  ResourceId: 11208654,
  SessionId: "58691643",
  SessionName: "65 - Blue Starter",
  ParticipantId: "60307227",
  ParticipantName: "Osborn",
  Comments: "Test",
  Id: "60307810",
  Date: "2026-09-05T03:29:50.849",
};

const DISQUALIFIED = {
  $type: "ParticipantDisqualifiedNotification",
  ResourceId: 11208654,
  SessionId: "58691643",
  SessionName: "65 - Blue Starter",
  ParticipantId: "60307227",
  ParticipantName: "Osborn",
  Comments: "test",
  Id: "60307825",
  Date: "2026-09-05T03:33:31.62",
};

const CRASH_KART_4 = {
  $type: "CrashNotification",
  RentalObjectId: "11230172",
  RentalObjectName: "4",
  Date: "2026-09-03T20:05:48.026",
  ExpireTime: "2026-09-03T20:06:08.0137843-04:00",
  NotificationMetaId: -108,
  Id: "60246942",
};

const PASSING_KART_15 = {
  $type: "TimingPassingNotification",
  LapTimeMs: 31208,
  PassingTimeUtc: "2026-09-05T03:31:48.000Z",
  PassingId: "60307820",
  RentalObjectId: "11230373",
  RentalObjectName: "15",
  TransponderCode: "25:04:67:3d:75:07",
  ParticipantId: "60307227",
  ParticipantName: "Eric Osborn",
  SessionId: "58691643",
  SessionName: "65 - Blue Starter",
  ResourceId: 11208654,
  Id: "60307821",
  Date: "2026-09-05T03:31:48.100",
};

/** A rollout crossing — the venue really does omit LapTimeMs entirely. */
const PASSING_ROLLOUT = {
  ...PASSING_KART_15,
  PassingId: "60307801",
  Id: "60307802",
  LapTimeMs: undefined,
  PassingTimeUtc: "2026-09-05T03:28:10.000Z",
};

const CHEQUERED = {
  $type: "CheckeredFlagNotification",
  ResourceId: 11208654,
  SessionId: "58691643",
  SessionName: "65 - Blue Starter",
  Id: "60307830",
  Date: "2026-09-05T03:34:11.000",
};

const EMERGENCY = {
  $type: "EmergencyOnNotification",
  NotificationMetaId: -106,
  ResourceId: "11208654",
  Id: "60261267",
  Date: "2026-09-03T21:45:41.301",
};

/** Kart 15, bound to the participant the flags name. */
const OURS: RoutingContext = {
  kart: "15",
  participantId: "60307227",
  sessionId: "58691643",
  resourceId: "11208654",
};

/** Someone else on the same grid — same session, different kart and driver. */
const THEIRS: RoutingContext = {
  kart: "22",
  participantId: "60307999",
  sessionId: "58691643",
  resourceId: "11208654",
};

const ARRIVED = Date.parse("2026-09-05T07:29:33.000Z");

describe("classify — participant-keyed flags reach the right kart", () => {
  it("routes a blue flag to the bound kart", () => {
    const a = classify(BLUE_FLAG, OURS, ARRIVED);
    expect(a?.kind).toBe("blue");
    expect(a?.level).toBe("takeover");
    expect(a?.kart).toBe("15");
    expect(a?.sessionId).toBe("58691643");
  });

  it("does NOT route another driver's blue flag to this kart", () => {
    // The whole point of the binding: same session, same track, wrong driver.
    expect(classify(BLUE_FLAG, THEIRS, ARRIVED)).toBeNull();
  });

  it("shows no flag at all when the kart is not yet bound", () => {
    const unbound: RoutingContext = { ...OURS, participantId: null };
    expect(classify(BLUE_FLAG, unbound, ARRIVED)).toBeNull();
  });

  it("passes race control's Comments through verbatim", () => {
    expect(classify(BLACK_WHITE, OURS, ARRIVED)?.note).toBe("Test");
    expect(classify(DISQUALIFIED, OURS, ARRIVED)?.note).toBe("test");
  });
});

describe("classify — a crash is a takeover for one kart and a caution for the rest", () => {
  it("gives the crashing kart the instruction screen", () => {
    const ctx: RoutingContext = { ...OURS, kart: "4" };
    const a = classify(CRASH_KART_4, ctx, ARRIVED);
    expect(a?.kind).toBe("crash");
    expect(a?.kart).toBe("4");
  });

  it("gives everyone else the automatic caution, naming the kart that spun", () => {
    const a = classify(CRASH_KART_4, OURS, ARRIVED);
    expect(a?.kind).toBe("caution");
    expect(a?.value).toBe("4");
    expect(a?.kart).toBe("15");
  });

  it("carries the crash's own expiry rather than inventing one", () => {
    const a = classify(CRASH_KART_4, OURS, ARRIVED);
    // ExpireTime is 20s after the crash and carries its own -04:00 offset.
    expect(a?.expiresAtMs).toBe(Date.parse("2026-09-03T20:06:08.0137843-04:00"));
  });
});

describe("classify — session and track scope", () => {
  it("gives the chequered flag to a kart in that session", () => {
    expect(classify(CHEQUERED, OURS, ARRIVED)?.kind).toBe("chequered");
  });

  it("withholds it from a kart in a different session", () => {
    const other: RoutingContext = { ...OURS, sessionId: "58691999" };
    expect(classify(CHEQUERED, other, ARRIVED)).toBeNull();
  });

  it("scopes an emergency to its own track", () => {
    expect(classify(EMERGENCY, OURS, ARRIVED)?.kind).toBe("red");
    const redTrack: RoutingContext = { ...OURS, resourceId: "11208660" };
    expect(classify(EMERGENCY, redTrack, ARRIVED)).toBeNull();
  });
});

describe("readPassing", () => {
  it("reads a timed crossing for the kart we follow", () => {
    const p = readPassing(PASSING_KART_15, "15");
    expect(p?.lapTimeMs).toBe(31208);
    expect(p?.participantId).toBe("60307227");
    expect(p?.atUtc).toBe("2026-09-05T03:31:48.000Z");
  });

  it("ignores another kart's crossing", () => {
    expect(readPassing(PASSING_KART_15, "22")).toBeNull();
  });

  it("keeps a rollout crossing but gives it no time — never zero", () => {
    const p = readPassing(PASSING_ROLLOUT, "15");
    expect(p).not.toBeNull();
    expect(p?.lapTimeMs).toBeNull();
  });
});

describe("venue dates", () => {
  it("reads a bare stamp as Eastern wall-clock, not UTC", () => {
    // 03:29:32.806 ET on 2026-09-05 is 07:29:32.806Z — EDT, UTC-4.
    expect(venueDateToMs("2026-09-05T03:29:32.806", 0)).toBe(
      Date.parse("2026-09-05T07:29:32.806Z"),
    );
  });

  it("respects a stamp that carries its own offset", () => {
    expect(venueDateToMs("2026-09-03T20:06:08.0137843-04:00", 0)).toBe(
      Date.parse("2026-09-03T20:06:08.013-04:00"),
    );
  });

  it("handles standard time as well as daylight time", () => {
    // January is EST, UTC-5.
    expect(parseEasternWallClock("2026-01-15T12:00:00")).toBe(Date.parse("2026-01-15T17:00:00Z"));
  });

  it("falls back rather than dropping an alert with an unreadable stamp", () => {
    expect(venueDateToMs("not a date", 1234)).toBe(1234);
    expect(venueDateToMs(undefined, 1234)).toBe(1234);
  });
});
