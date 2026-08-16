import { describe, expect, it } from "vitest";
import { PULL_LATE_MS, pullIsLate, pullVerdict, type PullInput } from "./pull-to-room";

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
    expect(pullVerdict(CLEAR)).toEqual({ ok: true, late: false });
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
    expect(pullVerdict({ ...CLEAR, enabled: undefined })).toEqual({ ok: true, late: false });
  });

  it("carries lateness through without ever refusing on it", () => {
    expect(pullVerdict({ ...CLEAR, late: true })).toEqual({ ok: true, late: true });
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
