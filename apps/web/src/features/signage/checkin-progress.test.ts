import { describe, expect, it } from "vitest";
import {
  checkinRailState,
  checkingInTracks,
  countCheckedIn,
  isLockedPlace,
  participantCheckedIn,
  readyToSend,
  roomCheckinProgress,
  sessionLabel,
  waitingMs,
  type CheckinProgressSession,
} from "./checkin-progress";

describe("participantCheckedIn — checkedIn is a TIMESTAMP, not a flag", () => {
  it("THE BUG THIS EXISTS FOR: a Pandora timestamp counts as checked in", () => {
    // Participant.checkedIn is `string | null`. The track board compared it to
    // `true` and therefore reported 0 of N for every heat ever run.
    expect(participantCheckedIn({ checkedIn: "2026-08-12T16:04:11" })).toBe(true);
  });

  it("absent, null and blank all mean not yet", () => {
    expect(participantCheckedIn({})).toBe(false);
    expect(participantCheckedIn({ checkedIn: null })).toBe(false);
    expect(participantCheckedIn({ checkedIn: "" })).toBe(false);
    expect(participantCheckedIn({ checkedIn: "   " })).toBe(false);
  });

  it("still accepts a boolean, in case an upstream ever sends one", () => {
    expect(participantCheckedIn({ checkedIn: true })).toBe(true);
    expect(participantCheckedIn({ checkedIn: false })).toBe(false);
  });
});

describe("isLockedPlace", () => {
  /**
   * THE REAL ROW, verbatim from Pandora — one place locked by staff on Mega
   * heat 67 (session 59039776) on 2026-08-25 and read straight back off
   * /bmi/session/{loc}/{sid}/participants. Kept whole rather than trimmed to
   * the fields under test: the point of this fixture is that the ONLY thing
   * distinguishing it from a racer is that nobody is in it.
   */
  const lockedPlace = {
    participantId: "59595194",
    personId: null,
    firstName: null,
    lastName: null,
    email: null,
    homePhone: null,
    mobilePhone: null,
    paid: false,
    kartNumber: null,
    raceInfo: { startPosition: 0, finishPosition: 0, laps: 0, bestLap: 0, average: 0 },
    viewpointCredit: 0,
    headsockCredit: 0,
    checkedIn: null,
    guardian: null,
  };

  it("THE ROW THIS EXISTS FOR: a place locked in BMI, as Pandora sends it", () => {
    expect(isLockedPlace(lockedPlace)).toBe(true);
  });

  it("survives excludeRemoved=true, so it is not a removed racer", () => {
    // Recorded on the same probe: both filter modes returned it. A rule that
    // assumed the removed filter would take care of these would never fire.
    expect(isLockedPlace({ ...lockedPlace, checkedIn: null })).toBe(true);
  });

  it("a racer is never one — 17-digit ids included", () => {
    expect(isLockedPlace({ personId: "63000000003415010" })).toBe(false);
    expect(isLockedPlace({ personId: "1707260" })).toBe(false);
  });

  it("an empty or blank id counts as locked — a card cannot join on it either", () => {
    expect(isLockedPlace({ personId: "" })).toBe(true);
    expect(isLockedPlace({ personId: "   " })).toBe(true);
  });

  it("the DRIVER 1 PLACEHOLDER is NOT this — it is a booked seat with no name", () => {
    // id 17750277 has a person behind it and is filtered elsewhere
    // (dropNullParticipants). Conflating the two would hide a real booking.
    expect(isLockedPlace({ personId: "17750277" })).toBe(false);
  });
});

describe("countCheckedIn", () => {
  it("counts stamps against the whole roster", () => {
    expect(
      countCheckedIn([
        { personId: "1", checkedIn: "2026-08-12T16:00:00" },
        { personId: "2", checkedIn: null },
        { personId: "3", checkedIn: "2026-08-12T16:02:00" },
        { personId: "4" },
      ]),
    ).toEqual({ checkedIn: 2, total: 4 });
  });

  it("A LOCKED PLACE IS NOT A PERSON — it leaves the denominator alone", () => {
    // Mega 67, 2026-08-25: one racer, one locked place. The rail said "0 of 2"
    // and could never reach 2, while the desk's own strip said "0 of 1".
    expect(
      countCheckedIn([
        { personId: "63000000003415010", checkedIn: null },
        { personId: null, checkedIn: null },
      ]),
    ).toEqual({ checkedIn: 0, total: 1 });
  });

  it("a heat of one racer and three locked places completes at 1 of 1", () => {
    expect(
      countCheckedIn([
        { personId: "1707260", checkedIn: "2026-08-26T00:19:32.000Z" },
        { personId: null },
        { personId: null },
        { personId: null },
      ]),
    ).toEqual({ checkedIn: 1, total: 1 });
  });

  it("an empty roster is 0 of 0, not a crash", () => {
    expect(countCheckedIn([])).toEqual({ checkedIn: 0, total: 0 });
  });

  it("a roster of nothing but locked places is 0 of 0, not 0 of 3", () => {
    expect(countCheckedIn([{ personId: null }, { personId: null }, { personId: null }])).toEqual({
      checkedIn: 0,
      total: 0,
    });
  });
});

describe("checkingInTracks — the same 'currently' the check-in station uses", () => {
  const now = Date.parse("2026-08-12T20:30:00.000Z");
  const called = (mins: number) => new Date(now - mins * 60_000).toISOString();

  it("keeps a heat called minutes ago, on every track that has one", () => {
    const out = checkingInTracks(
      {
        blue: {
          sessionId: 41781713,
          heatNumber: 29,
          raceType: "Junior Starter",
          calledAt: called(4),
        },
        red: { sessionId: "41781714", heatNumber: 12, raceType: "Pro", calledAt: called(9) },
        mega: null,
      },
      now,
    );
    expect(out).toEqual([
      {
        track: "blue",
        sessionId: "41781713",
        heatNumber: 29,
        raceType: "Junior Starter",
        calledAtMs: now - 4 * 60_000,
      },
      {
        track: "red",
        sessionId: "41781714",
        heatNumber: 12,
        raceType: "Pro",
        calledAtMs: now - 9 * 60_000,
      },
    ]);
  });

  it("carries no call time rather than a bogus one when the stamp is unparseable", () => {
    const [only] = checkingInTracks({ blue: { sessionId: 1, calledAt: "not a date" } }, now);
    expect(only.calledAtMs).toBeNull();
  });

  it("drops last night's finale — the age gate is what 'currently' means", () => {
    const out = checkingInTracks(
      { blue: { sessionId: 1, heatNumber: 61, calledAt: called(9 * 60) } },
      now,
    );
    expect(out).toEqual([]);
  });

  it("drops an entry with no session id — there is nothing to count", () => {
    expect(checkingInTracks({ blue: { heatNumber: 3, calledAt: called(2) } }, now)).toEqual([]);
    expect(checkingInTracks({ blue: { sessionId: "", calledAt: called(2) } }, now)).toEqual([]);
  });

  it("keeps the session id a STRING, never a number", () => {
    const [only] = checkingInTracks({ mega: { sessionId: 41781713, calledAt: called(1) } }, now);
    expect(only.sessionId).toBe("41781713");
    expect(typeof only.sessionId).toBe("string");
  });
});

describe("roomCheckinProgress — this room's heat, and only this room's", () => {
  const session = (
    track: CheckinProgressSession["track"],
    heatNumber: number,
    briefed = false,
  ): CheckinProgressSession => ({
    track,
    heatNumber,
    raceType: "Starter",
    sessionId: `s${heatNumber}`,
    checkedIn: 1,
    total: 4,
    briefed,
    calledAtMs: null,
  });

  it("THE REQUIREMENT: the other track's heat never reaches the room", () => {
    const out = roomCheckinProgress([session("red", 11), session("blue", 29)], "blue");
    expect(out?.track).toBe("blue");
    expect(out?.heatNumber).toBe(29);
  });

  it("is null when nothing of this room's is checking in", () => {
    expect(roomCheckinProgress([session("red", 11)], "blue")).toBeNull();
    expect(roomCheckinProgress([], "blue")).toBeNull();
  });

  it("MEGA DAY: a blue board takes the Mega heat, because that is what is checking in for it", () => {
    const out = roomCheckinProgress([session("mega", 12)], "blue");
    expect(out?.track).toBe("mega");
  });

  it("prefers its own track over a stale mega row on an ordinary day", () => {
    const out = roomCheckinProgress([session("mega", 12), session("blue", 29)], "blue");
    expect(out?.track).toBe("blue");
  });

  it("takes the earliest heat when its track somehow has two", () => {
    const out = roomCheckinProgress([session("blue", 31), session("blue", 29)], "blue");
    expect(out?.heatNumber).toBe(29);
  });

  it("a board with no track shows no rail at all", () => {
    expect(roomCheckinProgress([session("blue", 29)], null)).toBeNull();
  });

  it("SENT TO A ROOM ⇒ the rail clears; check-in is over", () => {
    expect(roomCheckinProgress([session("blue", 29, true)], "blue")).toBeNull();
  });

  it("a sent heat does not hide the next one that has been called", () => {
    const out = roomCheckinProgress([session("blue", 29, true), session("blue", 30)], "blue");
    expect(out?.heatNumber).toBe(30);
  });

  it("does not mutate the array it was given", () => {
    const input = [session("red", 30), session("blue", 12)];
    roomCheckinProgress(input, "blue");
    expect(input.map((s) => s.track)).toEqual(["red", "blue"]);
  });
});

describe("sessionLabel — one name for a heat, on every strip of the board", () => {
  it("matches the camera caption's wording", () => {
    expect(sessionLabel(31, "Pro")).toBe("Session 31 · Pro");
  });

  it("keeps Mega's word, because a Mega heat in the Blue room IS different", () => {
    expect(sessionLabel(31, "Pro", "mega")).toBe("Mega session 31 · Pro");
    expect(sessionLabel(31, "Pro", "blue")).toBe("Session 31 · Pro");
  });

  it("degrades without a heat number or a type rather than printing a gap", () => {
    expect(sessionLabel(null, "Pro")).toBe("Session · Pro");
    expect(sessionLabel(31, "")).toBe("Session 31");
  });
});

describe("checkinRailState — the desk board's escalation, on a wall", () => {
  const now = Date.parse("2026-08-12T20:30:00.000Z");
  const WINDOW = 8;
  const heat = (
    checkedIn: number,
    total: number,
    calledMinsAgo: number | null,
  ): CheckinProgressSession => ({
    track: "blue",
    heatNumber: 31,
    raceType: "Pro",
    sessionId: "s31",
    checkedIn,
    total,
    briefed: false,
    calledAtMs: calledMinsAgo == null ? null : now - calledMinsAgo * 60_000,
  });

  it("counts quietly while people are still arriving", () => {
    expect(checkinRailState(heat(3, 6, 2), now, WINDOW)).toBe("counting");
  });

  it("FLASHES GREEN the moment the last racer is in", () => {
    expect(checkinRailState(heat(6, 6, 2), now, WINDOW)).toBe("ready");
  });

  it("warns in the last minute of the window, matching the desk board", () => {
    expect(checkinRailState(heat(3, 6, 7.5), now, WINDOW)).toBe("closing");
  });

  it("THE REQUIREMENT: past the window it is overdue — they have waited too long", () => {
    expect(checkinRailState(heat(3, 6, 9), now, WINDOW)).toBe("overdue");
  });

  it("overdue outranks ready: all present and STILL not sent is the worse state", () => {
    expect(checkinRailState(heat(6, 6, 12), now, WINDOW)).toBe("overdue");
  });

  it("no call time ⇒ no deadline invented; it just counts", () => {
    expect(checkinRailState(heat(3, 6, null), now, WINDOW)).toBe("counting");
    expect(checkinRailState(heat(6, 6, null), now, WINDOW)).toBe("ready");
  });

  it("a switched-off window never escalates", () => {
    expect(checkinRailState(heat(3, 6, 60), now, 0)).toBe("counting");
  });

  it("an empty roster is not a full one", () => {
    expect(readyToSend(heat(0, 0, 1))).toBe(false);
  });

  it("waitingMs counts UP from the call, never negative", () => {
    expect(waitingMs(heat(1, 6, 4), now)).toBe(4 * 60_000);
    expect(waitingMs(heat(1, 6, -2), now)).toBe(0);
    expect(waitingMs(heat(1, 6, null), now)).toBeNull();
  });
});
