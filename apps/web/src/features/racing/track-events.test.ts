import { describe, expect, it } from "vitest";
import { extractEmergencies, extractSessionLifecycle } from "./venue-broadcast";

/**
 * REAL WIRE RECORDS, verbatim from `kart:events:queue` on 2026-08-16 — Blue
 * track, heat 60 (session 58599025), the night this feature was built.
 *
 * That heat is the fixture BECAUSE it was a bad ten minutes, and every awkward
 * case is in it:
 *
 *   23:10:00.716  session started
 *   23:13:36.130  PAUSED with no emergency before it  ← a DESK pause
 *   23:14:45.055  resumed
 *   23:15:02.651  EMERGENCY ON
 *   23:15:03.211  paused, 0.56s later                 ← the E-stop's own pause
 *   23:18:02.413  resumed, still under the emergency
 *   23:18:07.866  emergency off
 *   23:18:08.809  EMERGENCY ON again, 0.94s later     ← it chatters
 *   23:18:10.028  paused again
 *   23:18:12.610  emergency off
 *   23:18:20.574  EMERGENCY ON, third time            ← same MINUTE as the last
 *   23:20:27.602  resumed
 *   23:20:37.787  emergency off
 *   23:24:26.881  session finished
 *   23:25:24.162  session finished AGAIN              ← delivered twice
 */
const SESSION_STARTED = {
  $type: "SessionStartedNotification",
  ResourceId: 11208654,
  SessionId: 58599025,
  SessionName: "60 - Blue Starter",
  NotificationMetaId: -5005,
  Id: 58992031,
  Date: "2026-08-16T23:10:00.716",
};

const DESK_PAUSE = {
  $type: "SessionPausedNotification",
  ResourceId: 11208654,
  SessionId: 58599025,
  SessionName: "60 - Blue Starter",
  NotificationMetaId: -5013,
  Id: 58992297,
  Date: "2026-08-16T23:13:36.13",
};

const EMERGENCY_ON_1 = {
  $type: "EmergencyOnNotification",
  NotificationMetaId: -106,
  ResourceId: 11208654,
  Id: 58992360,
  Date: "2026-08-16T23:15:02.651",
};

const ESTOP_PAUSE = {
  $type: "SessionPausedNotification",
  ResourceId: 11208654,
  SessionId: 58599025,
  SessionName: "60 - Blue Starter",
  NotificationMetaId: -5013,
  Id: 58992373,
  Date: "2026-08-16T23:15:03.211",
};

const EMERGENCY_OFF_2 = {
  $type: "EmergencyOffNotification",
  NotificationMetaId: -107,
  ResourceId: 11208654,
  Id: 58992432,
  Date: "2026-08-16T23:18:12.61",
};

const EMERGENCY_ON_3 = {
  $type: "EmergencyOnNotification",
  NotificationMetaId: -106,
  ResourceId: 11208654,
  Id: 58992455,
  Date: "2026-08-16T23:18:20.574",
};

const SESSION_FINISHED = {
  $type: "SessionFinishedNotification",
  ResourceId: 11208654,
  SessionId: 58599025,
  SessionName: "60 - Blue Starter",
  NotificationMetaId: -5007,
  Id: 58992707,
  Date: "2026-08-16T23:24:26.881",
};

/** A RED-track lifecycle record, so track resolution is not trivially "blue". */
const RED_STARTED = {
  $type: "SessionStartedNotification",
  ResourceId: 11208660,
  SessionId: 58599150,
  SessionName: "60 - Red Intermediate",
  NotificationMetaId: -5005,
  Id: 58991015,
  Date: "2026-08-16T22:56:22.551",
};

/** Types the extractors must walk straight past. */
const NOISE = [
  { $type: "BcTime", DateTime: "2026-08-16T23:19:04.120541-04:00" },
  {
    $type: "CrashNotification",
    RentalObjectId: 11230597,
    RentalObjectName: "34",
    Date: "2026-08-16T23:18:20.79",
    NotificationMetaId: -108,
    Id: 58992465,
  },
  {
    $type: "SessionAboutToStartNotification",
    SessionId: 58599023,
    SessionName: "59 - Blue Intermediate",
    NotificationMetaId: -5022,
    ResourceId: 11208654,
    Id: 58988809,
    Date: "2026-08-16T22:32:02.395",
  },
  {
    $type: "CheckeredFlagNotification",
    ResourceId: 11208654,
    SessionId: 58599025,
    SessionName: "60 - Blue Starter",
    NotificationMetaId: -119,
    Id: 58992706,
    Date: "2026-08-16T23:24:26.881",
  },
];

describe("extractSessionLifecycle", () => {
  it("reads the four lifecycle kinds and ignores everything else", () => {
    const out = extractSessionLifecycle([
      SESSION_STARTED,
      DESK_PAUSE,
      SESSION_FINISHED,
      ...NOISE,
      EMERGENCY_ON_1,
    ]);
    expect(out.map((e) => e.kind)).toEqual(["started", "paused", "finished"]);
  });

  it("carries the venue's own stamp, not our clock", () => {
    const [started] = extractSessionLifecycle(SESSION_STARTED);
    // 23:10:00.716 venue-local ET on 16 Aug = 03:10:00.716Z on the 17th (EDT).
    expect(new Date(started.atMs!).toISOString()).toBe("2026-08-17T03:10:00.716Z");
  });

  it("resolves track and heat number off the record", () => {
    const [blue] = extractSessionLifecycle(SESSION_STARTED);
    expect(blue.track).toBe("blue");
    expect(blue.heatNumber).toBe(60);
    expect(blue.sessionName).toBe("60 - Blue Starter");

    const [red] = extractSessionLifecycle(RED_STARTED);
    expect(red.track).toBe("red");
  });

  it("keeps the session id as a STRING — never a Number round-trip", () => {
    const [started] = extractSessionLifecycle(SESSION_STARTED);
    expect(started.sessionId).toBe("58599025");
    expect(typeof started.sessionId).toBe("string");
  });

  it("handles a single record as well as an array", () => {
    expect(extractSessionLifecycle(DESK_PAUSE)).toHaveLength(1);
  });

  it("survives junk without throwing", () => {
    expect(extractSessionLifecycle(null)).toEqual([]);
    expect(extractSessionLifecycle([null, 42, "x", {}])).toEqual([]);
    // A lifecycle type with no SessionId is not usable and must be skipped.
    expect(
      extractSessionLifecycle({ $type: "SessionPausedNotification", ResourceId: 11208654 }),
    ).toEqual([]);
  });
});

describe("extractEmergencies", () => {
  it("reads polarity from the type, not the name", () => {
    const out = extractEmergencies([EMERGENCY_ON_1, EMERGENCY_OFF_2, EMERGENCY_ON_3]);
    expect(out.map((e) => e.on)).toEqual([true, false, true]);
  });

  it("resolves the track and refuses to invent a session", () => {
    const [em] = extractEmergencies(EMERGENCY_ON_1);
    expect(em.track).toBe("blue");
    // The whole reason inferred_session_id exists — see track-events-db.ts.
    expect(Object.keys(em)).toEqual(["track", "on", "atMs"]);
  });

  it("keeps two E-stops in the SAME MINUTE as two distinct events", () => {
    const out = extractEmergencies([EMERGENCY_ON_3, EMERGENCY_OFF_2]);
    const [on3, off2] = out;
    // 23:18:20.574 vs 23:18:12.610 — eight seconds apart, same minute. A
    // minute-resolution identity would collapse these, which is exactly the
    // bug the bookmark claim key had to be changed to avoid.
    expect(on3.atMs).not.toBe(off2.atMs);
    expect(on3.atMs! - off2.atMs!).toBe(7964);
  });

  it("ignores every other record type", () => {
    expect(extractEmergencies([...NOISE, SESSION_STARTED, DESK_PAUSE])).toEqual([]);
  });

  it("survives junk without throwing", () => {
    expect(extractEmergencies(undefined)).toEqual([]);
    expect(extractEmergencies([null, "x", { $type: "EmergencyOnNotification" }])).toHaveLength(1);
  });
});

/**
 * THE SUPPRESSION RULE, as arithmetic rather than as Redis.
 *
 * The handler's own gate is a Redis marker (track-events.server.ts), which is
 * not unit-testable without standing up Redis. What IS testable, and what the
 * rule actually rests on, is the claim that an E-stop's pause is
 * distinguishable from a desk pause by the wire alone — so this pins the real
 * timings the rule was derived from. If a future venue upgrade moved the pause
 * to BEFORE the emergency, or minutes after it, this fails and the rule needs
 * revisiting.
 */
describe("the E-stop / pause relationship the suppression rule depends on", () => {
  const at = (rec: unknown) =>
    (extractEmergencies(rec)[0]?.atMs ?? extractSessionLifecycle(rec)[0]?.atMs)!;

  it("puts the E-stop BEFORE the pause it causes, well under a second", () => {
    const gap = at(ESTOP_PAUSE) - at(EMERGENCY_ON_1);
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBe(560);
  });

  it("leaves the desk pause with no emergency anywhere near it", () => {
    // 23:13:36.130 pause vs 23:15:02.651 E-stop — 86 seconds later, and the
    // emergency marker is only raised when an EmergencyOn actually arrives.
    const gap = at(EMERGENCY_ON_1) - at(DESK_PAUSE);
    expect(gap).toBe(86521);
  });
});
