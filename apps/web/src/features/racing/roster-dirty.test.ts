import { describe, expect, it } from "vitest";
import {
  BRIDGE_STALE_MS,
  NET_FAR_MS,
  NET_NEAR_MS,
  planRosterRead,
  rosterTouchedSessionIds,
  type RosterReadInput,
} from "./roster-dirty";

/** REAL WIRE RECORDS, verbatim from `kart:events:queue` (survey 2026-08-19). */
const ENTER_TAP = {
  $type: "EnterTapNotification",
  TrapName: "Pit Area",
  ParticipantId: 58964040,
  ParticipantName: "Makenna Smith",
  SessionId: 58599015,
  SessionName: "55 - Blue Junior Starter",
  Id: 58987260,
};
const DNS = {
  $type: "ParticipantDidNotStartNotification",
  ResourceId: 11208654,
  SessionId: 58599019,
  SessionName: "57 - Blue Starter",
  ParticipantId: 58964057,
  ParticipantName: "Bonett",
  Id: 58990086,
};
const SESSION_FULL = {
  $type: "SessionFullNotification",
  ResourceId: 11208654,
  SessionId: 58599019,
  SessionName: "57 - Blue Starter",
  ParticipantsCount: 14,
  Id: 58988751,
};
/** No SessionId on this type — see the module doc. */
const ASSIGNMENT = {
  $type: "AssignmentNotification",
  ParticipantId: 58964040,
  RentalObjectName: "54",
  Id: 58986970,
  Date: "2026-08-16T21:56:22.411",
};
const RACE_ADVICE = {
  $type: "RaceAdvice",
  RaceId: 58599144,
  ResourceId: 11208660,
  Name: "57 - Red Intermediate",
  Drivers: [{ $type: "BcDriver", DriverId: 58973637, PersonId: 11775736, Alias: "Zach Adebayo" }],
};
const SPEED_CHANGE = { $type: "SpeedChange", RentalObjectName: "54" };

describe("rosterTouchedSessionIds", () => {
  it("marks the session an EnterTap, a DNS and a SessionFull name", () => {
    expect(rosterTouchedSessionIds(ENTER_TAP)).toEqual(["58599015"]);
    expect(rosterTouchedSessionIds(DNS)).toEqual(["58599019"]);
    expect(rosterTouchedSessionIds(SESSION_FULL)).toEqual(["58599019"]);
  });

  it("marks RaceAdvice by RaceId — the same id space as a Pandora sessionId", () => {
    expect(rosterTouchedSessionIds(RACE_ADVICE)).toEqual(["58599144"]);
  });

  it("ignores AssignmentNotification, which carries no SessionId to mark", () => {
    expect(rosterTouchedSessionIds(ASSIGNMENT)).toEqual([]);
  });

  it("ignores the noise types that make up most of the pipe", () => {
    // SpeedChange alone is 53,398 of 88,280 frames — marking on it would make
    // every session permanently dirty and undo the whole point.
    expect(rosterTouchedSessionIds(SPEED_CHANGE)).toEqual([]);
  });

  it("handles an array frame and dedupes repeats within it", () => {
    const ids = rosterTouchedSessionIds([RACE_ADVICE, RACE_ADVICE, DNS, SPEED_CHANGE]);
    expect(ids).toEqual(["58599144", "58599019"]);
  });

  it("never returns a session id as a Number round-trip", () => {
    // 17-digit ids exist in this id space; String() is the house rule.
    const big = { $type: "EnterTapNotification", SessionId: "63000000008644700" };
    expect(rosterTouchedSessionIds(big)).toEqual(["63000000008644700"]);
  });

  it("survives junk without throwing — it runs on the webhook hot path", () => {
    expect(rosterTouchedSessionIds(null)).toEqual([]);
    expect(rosterTouchedSessionIds("nope")).toEqual([]);
    expect(rosterTouchedSessionIds([null, 7, { $type: "RaceAdvice" }])).toEqual([]);
  });
});

const NOW = 1_760_000_000_000;
const base: RosterReadInput = {
  nowMs: NOW,
  scheduledStartMs: NOW + 30 * 60_000, // half an hour out → inside the near horizon
  nearHorizonMs: NOW + 2 * 60 * 60_000,
  dirtyCounter: 4,
  readCounter: 4,
  lastReadMs: NOW - 60_000,
  bridgeLastEventMs: NOW - 10_000,
};

describe("planRosterRead", () => {
  it("skips a heat nobody has touched since we last read it", () => {
    expect(planRosterRead(base)).toEqual({ read: false, reason: "quiet" });
  });

  it("reads a session we have never read — this is what makes all-day safe", () => {
    expect(planRosterRead({ ...base, lastReadMs: null, readCounter: null })).toEqual({
      read: true,
      reason: "never-read",
    });
    // Bookmark half-present is still "never read" — never infer the other half.
    expect(planRosterRead({ ...base, readCounter: null })).toEqual({
      read: true,
      reason: "never-read",
    });
  });

  it("reads the near horizon every tick when the bridge heartbeat is stale", () => {
    // The 8/17 15:07-15:19 failure: zero frames of any kind, four heats missed.
    const dead = { ...base, bridgeLastEventMs: NOW - BRIDGE_STALE_MS - 1 };
    expect(planRosterRead(dead)).toEqual({ read: true, reason: "bridge-stale" });
    expect(planRosterRead({ ...base, bridgeLastEventMs: null })).toEqual({
      read: true,
      reason: "bridge-stale",
    });
    expect(planRosterRead({ ...base, bridgeLastEventMs: NaN })).toEqual({
      read: true,
      reason: "bridge-stale",
    });
  });

  it("STOPS looking beyond the near horizon when the bridge is stale", () => {
    // The all-day scope is a WS feature. Keeping it while the WS is down means
    // reading every heat of the day on every tick — simulated against the real
    // wire that was 8,098 reads/day against the old 2,516, three times worse
    // than the behaviour it replaced. Falling back means falling back to BOTH
    // the old cadence and the old scope.
    const farDead = {
      ...base,
      scheduledStartMs: NOW + 5 * 60 * 60_000,
      bridgeLastEventMs: NOW - BRIDGE_STALE_MS - 1,
    };
    expect(planRosterRead(farDead)).toEqual({ read: false, reason: "bridge-stale-far" });
  });

  it("skips a far, never-read heat while the bridge is down — that is old behaviour", () => {
    // Ordering matters: bridge health is checked BEFORE never-read, because a
    // far heat we have never read is one the old code never read either.
    const coldFarDead = {
      ...base,
      scheduledStartMs: NOW + 5 * 60 * 60_000,
      lastReadMs: null,
      readCounter: null,
      bridgeLastEventMs: NOW - BRIDGE_STALE_MS - 1,
    };
    expect(planRosterRead(coldFarDead)).toEqual({ read: false, reason: "bridge-stale-far" });
  });

  it("reads when the wire's counter has moved past our bookmark", () => {
    expect(planRosterRead({ ...base, dirtyCounter: 5 })).toEqual({
      read: true,
      reason: "wire-touched",
    });
  });

  it("reads when the dirty key expired and the counter restarted below us", () => {
    // Counter reset to 0 (or absent) while we hold 4 — different, so read once
    // and re-sync. Wrong in the direction of one extra read, by design.
    expect(planRosterRead({ ...base, dirtyCounter: null })).toEqual({
      read: true,
      reason: "wire-touched",
    });
    expect(planRosterRead({ ...base, dirtyCounter: 1 })).toEqual({
      read: true,
      reason: "wire-touched",
    });
  });

  it("bounds how stale a quiet heat inside the near horizon can get", () => {
    // THE HAZARD: a skipped read contributes no candidates, so a racer added
    // during a dropped frame gets no e-ticket until the net fires. The net is
    // what turns "never" into "at most NET_NEAR_MS late".
    const justUnder = { ...base, lastReadMs: NOW - NET_NEAR_MS + 1 };
    expect(planRosterRead(justUnder).read).toBe(false);
    const due = { ...base, lastReadMs: NOW - NET_NEAR_MS };
    expect(planRosterRead(due)).toEqual({ read: true, reason: "net-due" });
  });

  it("lets a heat beyond the near horizon go longer between reads", () => {
    const far = { ...base, scheduledStartMs: NOW + 5 * 60 * 60_000 };
    expect(planRosterRead({ ...far, lastReadMs: NOW - NET_NEAR_MS }).read).toBe(false);
    expect(planRosterRead({ ...far, lastReadMs: NOW - NET_FAR_MS })).toEqual({
      read: true,
      reason: "net-due",
    });
  });

  it("treats an unparseable scheduled start as near rather than skipping on a guess", () => {
    const unknown = { ...base, scheduledStartMs: null, lastReadMs: NOW - NET_NEAR_MS };
    expect(planRosterRead(unknown)).toEqual({ read: true, reason: "net-due" });
  });

  it("re-reads a far heat as soon as it crosses the near horizon", () => {
    // This is why the far net can be hours long: crossing the horizon re-tiers
    // the heat to NET_NEAR_MS, whose clock is already long expired, so the
    // first tick inside it reads the heat regardless.
    const crossed = {
      ...base,
      scheduledStartMs: base.nearHorizonMs - 60_000, // just inside the horizon
      lastReadMs: NOW - 3 * 60 * 60_000, // last read hours ago, while far
    };
    expect(planRosterRead(crossed)).toEqual({ read: true, reason: "net-due" });
  });

  it("keeps the near net tighter than the far net", () => {
    expect(NET_NEAR_MS).toBeLessThan(NET_FAR_MS);
  });
});
