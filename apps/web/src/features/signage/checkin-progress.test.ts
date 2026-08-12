import { describe, expect, it } from "vitest";
import {
  checkingInTracks,
  countCheckedIn,
  orderCheckinProgress,
  participantCheckedIn,
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

describe("countCheckedIn", () => {
  it("counts stamps against the whole roster", () => {
    expect(
      countCheckedIn([
        { checkedIn: "2026-08-12T16:00:00" },
        { checkedIn: null },
        { checkedIn: "2026-08-12T16:02:00" },
        {},
      ]),
    ).toEqual({ checkedIn: 2, total: 4 });
  });

  it("an empty roster is 0 of 0, not a crash", () => {
    expect(countCheckedIn([])).toEqual({ checkedIn: 0, total: 0 });
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
      { track: "blue", sessionId: "41781713", heatNumber: 29, raceType: "Junior Starter" },
      { track: "red", sessionId: "41781714", heatNumber: 12, raceType: "Pro" },
    ]);
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

describe("orderCheckinProgress — this room's heat first", () => {
  const session = (
    track: CheckinProgressSession["track"],
    heatNumber: number,
  ): CheckinProgressSession => ({
    track,
    heatNumber,
    raceType: "Starter",
    sessionId: `s${heatNumber}`,
    checkedIn: 1,
    total: 4,
  });

  it("puts the board's own track at the top whatever the heat numbers say", () => {
    const out = orderCheckinProgress([session("red", 11), session("blue", 29)], "blue");
    expect(out.map((s) => s.track)).toEqual(["blue", "red"]);
  });

  it("orders the rest by heat number", () => {
    const out = orderCheckinProgress(
      [session("red", 30), session("mega", 12), session("blue", 29)],
      "blue",
    );
    expect(out.map((s) => s.heatNumber)).toEqual([29, 12, 30]);
  });

  it("a board with no track just reads in heat order", () => {
    const out = orderCheckinProgress([session("red", 30), session("blue", 12)], null);
    expect(out.map((s) => s.heatNumber)).toEqual([12, 30]);
  });

  it("does not mutate the array it was given", () => {
    const input = [session("red", 30), session("blue", 12)];
    orderCheckinProgress(input, "blue");
    expect(input.map((s) => s.track)).toEqual(["red", "blue"]);
  });
});
