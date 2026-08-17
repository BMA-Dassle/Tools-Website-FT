/**
 * The room-blocked alert's gate.
 *
 * The cases that matter are the ones where the room is FULL and the alert must
 * still stay quiet — a group watching the safety film, and a group whose film
 * nobody started. Both look identical to "somebody is in there" and neither may
 * be shouted at.
 */
import { describe, it, expect } from "vitest";
import { roomBlockedAlertAt } from "./room-blocked";
import { HELMET_PHASE_MS, type BriefingRoomState } from "./types";

const VIDEO_MS = 5 * 60_000;
const T0 = 1_700_000_000_000;

function room(over: Partial<BriefingRoomState> = {}): BriefingRoomState {
  return {
    kind: "timeline",
    tier: "starter",
    track: "red",
    raceType: "Starter",
    sessionId: "58000001",
    heatNumber: 41,
    triggeredAtMs: T0,
    videoUrl: "https://example.test/starter.mp4",
    videoDurationMs: VIDEO_MS,
    ...over,
  };
}

const WAITING = { heatNumber: 42 };
/** The first instant the helmet board has had its full run. */
const ARMED = T0 + VIDEO_MS + HELMET_PHASE_MS;

describe("roomBlockedAlertAt", () => {
  it("fires once the helmet board has had its 30 seconds and a race is waiting", () => {
    expect(roomBlockedAlertAt({ state: room(), waiting: WAITING, nowMs: ARMED })).toEqual({
      heatNumber: 42,
    });
  });

  it("stays quiet while the safety film is still playing", () => {
    // Mid-film, room full, race waiting — the one moment a group is doing
    // exactly what they were sat down to do.
    expect(
      roomBlockedAlertAt({ state: room(), waiting: WAITING, nowMs: T0 + VIDEO_MS - 1 }),
    ).toBeNull();
  });

  it("stays quiet for the helmet board's own run, to the last millisecond", () => {
    expect(roomBlockedAlertAt({ state: room(), waiting: WAITING, nowMs: ARMED - 1 })).toBeNull();
  });

  it("stays quiet on a room whose film was never started", () => {
    // `assigned` — sent in, nobody pressed Start. The room is just as full and
    // the race just as stuck, but "helmet up" would be telling people to gear
    // up before the safety briefing. The desk warns on this one instead.
    expect(
      roomBlockedAlertAt({
        state: room({ kind: "assigned" }),
        waiting: WAITING,
        nowMs: T0 + 20 * 60_000,
      }),
    ).toBeNull();
  });

  it("says nothing when no race is waiting on this room", () => {
    expect(roomBlockedAlertAt({ state: room(), waiting: null, nowMs: ARMED })).toBeNull();
  });

  it("says nothing about an idle room — it is blocking nobody", () => {
    expect(roomBlockedAlertAt({ state: null, waiting: WAITING, nowMs: ARMED })).toBeNull();
  });

  it("names no session when the waiting race has no heat number", () => {
    // A group event or a custom race. The alert still fires — the block is real
    // — and the copy falls back to "a race".
    expect(
      roomBlockedAlertAt({ state: room(), waiting: { heatNumber: null }, nowMs: ARMED }),
    ).toEqual({ heatNumber: null });
  });

  it("arms immediately after the 30s when the room has no film at all", () => {
    // No video URL ⇒ the timeline starts at the helmet board (videoMs is 0), so
    // a briefing sent before anyone uploaded a film is not held open for five
    // minutes by a film that does not exist.
    const filmless = room({ videoUrl: null, videoDurationMs: null });
    expect(
      roomBlockedAlertAt({ state: filmless, waiting: WAITING, nowMs: T0 + HELMET_PHASE_MS }),
    ).toEqual({ heatNumber: 42 });
    expect(
      roomBlockedAlertAt({ state: filmless, waiting: WAITING, nowMs: T0 + HELMET_PHASE_MS - 1 }),
    ).toBeNull();
  });

  it("keeps firing for as long as the room stays occupied", () => {
    // The helmet phase deliberately never ends (phase.ts), so a group nobody
    // moved on keeps the alert up. It clears when the room does, not on a timer.
    expect(
      roomBlockedAlertAt({ state: room(), waiting: WAITING, nowMs: ARMED + 20 * 60_000 }),
    ).toEqual({ heatNumber: 42 });
  });
});
