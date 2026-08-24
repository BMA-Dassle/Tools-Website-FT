import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILM_MS,
  PULL_LATE_MS,
  ROOM_EXIT_MS,
  SEND_GRACE_MS,
  SEND_OPEN_SLACK_MS,
  pullIsLate,
  pullVerdict,
  sendWindow,
  type PullInput,
} from "./pull-to-room";

/**
 * The owner's condition is one line — "if and only if all racers are checked in"
 * — and everything interesting here is what that line does NOT say: an
 * unreadable roster, a heat already sent, a room that still has somebody in it.
 * Those are the cases that decide whether the button is honest.
 */

const CLEAR: PullInput = {
  enabled: true,
  incoming: { sessionId: "9001", heatNumber: 61 },
  sentToRoom: null,
  inRoomHeatNumber: null,
  roomOccupied: false,
  checkedIn: { checkedIn: 12, total: 12 },
};

describe("pullVerdict", () => {
  it("allows a complete heat into a free room", () => {
    expect(pullVerdict(CLEAR)).toEqual({ ok: true, late: false, noTime: false });
  });

  it("refuses while the roster is short", () => {
    expect(pullVerdict({ ...CLEAR, checkedIn: { checkedIn: 9, total: 12 } })).toEqual({
      ok: false,
      reason: "not-all-checked-in",
    });
  });

  it("treats 0 of 0 as an unread roster, never as everybody being here", () => {
    expect(pullVerdict({ ...CLEAR, checkedIn: { checkedIn: 0, total: 0 } })).toEqual({
      ok: false,
      reason: "no-roster",
    });
    expect(pullVerdict({ ...CLEAR, checkedIn: null })).toEqual({
      ok: false,
      reason: "no-roster",
    });
  });

  it("allows an over-count — a racer added after the grid was read is still here", () => {
    expect(pullVerdict({ ...CLEAR, checkedIn: { checkedIn: 13, total: 12 } })).toEqual({
      ok: true,
      late: false,
      noTime: false,
    });
  });

  it("refuses when a group is still in this room, rather than offering to replace", () => {
    expect(pullVerdict({ ...CLEAR, roomOccupied: true, inRoomHeatNumber: 60 })).toEqual({
      ok: false,
      reason: "room-occupied",
    });
  });

  it("refuses a heat that has already gone to a room — including this one", () => {
    expect(pullVerdict({ ...CLEAR, sentToRoom: "blue" })).toEqual({
      ok: false,
      reason: "already-sent",
    });
    expect(pullVerdict({ ...CLEAR, sentToRoom: "red" })).toEqual({
      ok: false,
      reason: "already-sent",
    });
  });

  it("refuses with nothing checking in", () => {
    expect(pullVerdict({ ...CLEAR, incoming: null })).toEqual({ ok: false, reason: "no-heat" });
  });

  it("refuses when the kill switch is thrown, ahead of every other reason", () => {
    expect(
      pullVerdict({
        ...CLEAR,
        enabled: false,
        incoming: null,
        checkedIn: { checkedIn: 1, total: 12 },
      }),
    ).toEqual({ ok: false, reason: "disabled" });
  });

  it("treats an older board with no kill-switch field as switched on", () => {
    expect(pullVerdict({ ...CLEAR, enabled: undefined })).toEqual({
      ok: true,
      late: false,
      noTime: false,
    });
  });

  it("carries lateness through without ever refusing on it", () => {
    expect(pullVerdict({ ...CLEAR, late: true })).toEqual({ ok: true, late: true, noTime: false });
  });
});

describe("pullIsLate", () => {
  it("is late under five minutes and not at all above it", () => {
    expect(pullIsLate({ remainingMs: PULL_LATE_MS - 1, pitInOccupied: false, onTrack: true })).toBe(
      true,
    );
    expect(pullIsLate({ remainingMs: PULL_LATE_MS, pitInOccupied: false, onTrack: true })).toBe(
      false,
    );
    expect(pullIsLate({ remainingMs: 9 * 60_000, pitInOccupied: false, onTrack: true })).toBe(
      false,
    );
  });

  it("counts a finished race as the latest case of all", () => {
    expect(pullIsLate({ remainingMs: 0, pitInOccupied: false, onTrack: true })).toBe(true);
  });

  it("warns with no clock when the karts are already in the pit", () => {
    expect(pullIsLate({ remainingMs: null, pitInOccupied: true, onTrack: false })).toBe(true);
  });

  it("stays quiet on an empty track with an empty pit — that is a lull, not lateness", () => {
    expect(pullIsLate({ remainingMs: null, pitInOccupied: false, onTrack: false })).toBe(false);
  });

  it("stays quiet when a race is out but its clock is unreadable", () => {
    expect(pullIsLate({ remainingMs: null, pitInOccupied: false, onTrack: true })).toBe(false);
  });
});

/**
 * The send window turns the late warning's two numbers — race left, film length
 * — into a verdict. The edges that matter: the block firing exactly when the
 * film stops fitting, and the block LIFTING at the chequer, because once the
 * track is waiting the hold buys nothing.
 */

const M = 60_000;
const STARTER_FILM = 4.5 * M; // need = 5:00 with the exit
const NEED = STARTER_FILM + ROOM_EXIT_MS;
const RUNNING = {
  onTrack: true,
  onTrackHeatNumber: 48,
  filmMs: STARTER_FILM,
  pitPost: null,
  attribution: "this-room" as const,
};

describe("sendWindow", () => {
  it("is quiet on an empty track — an ended race lifts the block by itself", () => {
    expect(sendWindow({ ...RUNNING, remainingMs: null, onTrack: false }).kind).toBe("quiet");
  });

  it("is quiet when a race is out but its clock is unreadable", () => {
    expect(sendWindow({ ...RUNNING, remainingMs: null }).kind).toBe("quiet");
  });

  it("lifts the block the moment the clock hits zero, however long the feed lingers", () => {
    expect(sendWindow({ ...RUNNING, remainingMs: 0 }).kind).toBe("quiet");
    expect(sendWindow({ ...RUNNING, remainingMs: -30_000 }).kind).toBe("quiet");
  });

  it("reads early with lots of race left, and says when the window opens", () => {
    const w = sendWindow({ ...RUNNING, remainingMs: 9 * M });
    expect(w).toEqual({
      kind: "early",
      standMs: 9 * M - NEED,
      opensInMs: 9 * M - NEED - SEND_OPEN_SLACK_MS,
    });
  });

  it("opens when the film would land as the track clears", () => {
    expect(sendWindow({ ...RUNNING, remainingMs: 7 * M }).kind).toBe("open");
    expect(sendWindow({ ...RUNNING, remainingMs: NEED + SEND_OPEN_SLACK_MS }).kind).toBe("open");
    expect(sendWindow({ ...RUNNING, remainingMs: NEED }).kind).toBe("open");
  });

  /** THE OWNER'S OWN CASE (2026-08-23): a 4:30 starter film needs 5:00 and the
   *  race had 4:52 left. That must be GRACE — red, counting down, sendable —
   *  not the hard lock the first cut gave it. */
  it("grants a grace minute the moment the film stops fitting, and keeps the send live", () => {
    const w = sendWindow({ ...RUNNING, remainingMs: 4 * M + 52_000 });
    expect(w).toEqual({
      kind: "grace",
      remainingMs: 4 * M + 52_000,
      graceLeftMs: 52_000,
      overBy: 8_000,
    });
  });

  it("holds the grace to exactly one minute, then locks", () => {
    expect(sendWindow({ ...RUNNING, remainingMs: NEED - 1 }).kind).toBe("grace");
    expect(sendWindow({ ...RUNNING, remainingMs: NEED - SEND_GRACE_MS }).kind).toBe("grace");
    expect(sendWindow({ ...RUNNING, remainingMs: NEED - SEND_GRACE_MS - 1 })).toEqual({
      kind: "blocked",
      why: "film",
      heatNumber: 48,
      remainingMs: NEED - SEND_GRACE_MS - 1,
      postEndsInMs: null,
    });
  });

  it("sizes the window to the film this heat will actually get", () => {
    const proFilm = 46_000; // need = 1:16
    expect(sendWindow({ ...RUNNING, filmMs: proFilm, remainingMs: 2.5 * M }).kind).toBe("open");
    expect(sendWindow({ ...RUNNING, filmMs: proFilm, remainingMs: 70_000 }).kind).toBe("grace");
    expect(sendWindow({ ...RUNNING, filmMs: proFilm, remainingMs: 10_000 }).kind).toBe("blocked");
  });

  it("assumes the starter film when none is uploaded", () => {
    expect(DEFAULT_FILM_MS + ROOM_EXIT_MS).toBe(5 * M); // the owner's own number
    // 4:30 left ⇒ 30s into the grace on an assumed 5:00 need.
    expect(sendWindow({ ...RUNNING, filmMs: null, remainingMs: 4.5 * M })).toEqual({
      kind: "grace",
      remainingMs: 4.5 * M,
      graceLeftMs: 30_000,
      overBy: 30_000,
    });
    // Past the grace, the assumed film locks it just the same.
    expect(sendWindow({ ...RUNNING, filmMs: null, remainingMs: 3.5 * M }).kind).toBe("blocked");
  });

  it("stays blocked through the chequer while the post-race call is owed", () => {
    const w = sendWindow({
      ...RUNNING,
      remainingMs: null,
      onTrack: false,
      pitPost: { phase: "owed", heatNumber: 48, sinceFinishMs: 1 * M },
    });
    expect(w).toEqual({
      kind: "blocked",
      why: "post-owed",
      heatNumber: 48,
      remainingMs: null,
      postEndsInMs: null,
    });
  });

  it("counts down a playing post, and outranks the next race's fresh clock", () => {
    const w = sendWindow({
      ...RUNNING,
      remainingMs: 9 * M, // next race already green
      pitPost: { phase: "playing", heatNumber: 48, endsInMs: 20_000 },
    });
    expect(w).toEqual({
      kind: "blocked",
      why: "post-playing",
      heatNumber: 48,
      remainingMs: null,
      postEndsInMs: 20_000,
    });
  });

  it("stops waiting on a post that is not coming — the dead-cue cap", () => {
    const w = sendWindow({
      ...RUNNING,
      remainingMs: null,
      onTrack: false,
      pitPost: { phase: "owed", heatNumber: 48, sinceFinishMs: 5 * M },
    });
    expect(w.kind).toBe("quiet");
  });

  it("keeps the post block off the other Mega room, and soft on an unknown one", () => {
    const post = { phase: "owed" as const, heatNumber: 48, sinceFinishMs: 1 * M };
    expect(
      sendWindow({
        ...RUNNING,
        remainingMs: null,
        onTrack: false,
        pitPost: post,
        attribution: "other-room",
      }).kind,
    ).toBe("quiet");
    expect(
      sendWindow({
        ...RUNNING,
        remainingMs: null,
        onTrack: false,
        pitPost: post,
        attribution: "unknown",
      }).kind,
    ).toBe("grace");
  });

  it("downgrades the block to a loud warning when the returning room is unknown", () => {
    expect(sendWindow({ ...RUNNING, remainingMs: 2 * M, attribution: "unknown" })).toEqual({
      kind: "grace",
      remainingMs: 2 * M,
      graceLeftMs: 0,
      overBy: 0,
    });
  });

  it("keeps warnings off the other Mega room but still offers it the open window", () => {
    // In the grace, and past it — both silent on the room the returners are not
    // walking into.
    expect(sendWindow({ ...RUNNING, remainingMs: 4.6 * M, attribution: "other-room" }).kind).toBe(
      "quiet",
    );
    expect(sendWindow({ ...RUNNING, remainingMs: 2 * M, attribution: "other-room" }).kind).toBe(
      "quiet",
    );
    expect(sendWindow({ ...RUNNING, remainingMs: 7 * M, attribution: "other-room" }).kind).toBe(
      "open",
    );
  });

  it("keeps the band boundaries an exact ladder — no gaps, no overlaps", () => {
    for (let r = 5_000; r <= 10 * M; r += 5_000) {
      expect(sendWindow({ ...RUNNING, remainingMs: r }).kind).toBe(
        r < NEED - SEND_GRACE_MS
          ? "blocked"
          : r < NEED
            ? "grace"
            : r > NEED + SEND_OPEN_SLACK_MS
              ? "early"
              : "open",
      );
    }
  });
});

/**
 * NO TIME FOR THE FILM — a warning by default, a refusal only when staff have
 * switched the gear's override off (owner 2026-08-24: "make this a toggle in
 * settings… default to allow the override").
 */
describe("pullVerdict — no time for the film", () => {
  it("ALLOWS the send by default, and reports the warning with it", () => {
    expect(pullVerdict({ ...CLEAR, noTime: true })).toEqual({
      ok: true,
      late: false,
      noTime: true,
    });
  });

  it("allows it explicitly when the override is on", () => {
    expect(pullVerdict({ ...CLEAR, noTime: true, overrideAllowed: true })).toEqual({
      ok: true,
      late: false,
      noTime: true,
    });
  });

  it("refuses only when the override has been switched off", () => {
    expect(pullVerdict({ ...CLEAR, noTime: true, overrideAllowed: false })).toEqual({
      ok: false,
      reason: "no-time",
    });
  });

  it("carries lateness and no-time together — a caller cannot render one and miss the other", () => {
    expect(pullVerdict({ ...CLEAR, noTime: true, late: true })).toEqual({
      ok: true,
      late: true,
      noTime: true,
    });
  });

  it("lets the roster sentence win while both are true — scanning can happen during the wait", () => {
    expect(
      pullVerdict({
        ...CLEAR,
        checkedIn: { checkedIn: 9, total: 12 },
        noTime: true,
        overrideAllowed: false,
      }),
    ).toEqual({ ok: false, reason: "not-all-checked-in" });
  });
});
