import { describe, expect, it } from "vitest";
import { briefedFromRoomsByHeat, briefedFromRoomsBySession, type RoomStates } from "./room-briefed";
import type { BriefingRoomState } from "./types";

const SENT_AT = 1_755_640_000_000;

function room(over: Partial<BriefingRoomState> = {}): BriefingRoomState {
  return {
    kind: "assigned",
    tier: "starter",
    track: "blue",
    raceType: "Starter",
    sessionId: "58996064",
    heatNumber: 56,
    triggeredAtMs: SENT_AT,
    videoUrl: "https://blob/starter.mp4",
    videoDurationMs: 4 * 60_000,
    ...over,
  };
}

const rooms = (over: RoomStates = {}): RoomStates => ({ red: null, blue: null, ...over });

describe("briefedFromRoomsBySession — the track board's heat", () => {
  const row = {
    sessionId: 58996064,
    briefedAtMs: null,
    briefedRoom: null as "red" | "blue" | null,
  };

  it("marks the heat sent the moment a room says it is holding it", () => {
    const out = briefedFromRoomsBySession(row, rooms({ red: room() }));
    expect(out).toEqual({ sessionId: 58996064, briefedAtMs: SENT_AT, briefedRoom: "red" });
  });

  it("matches a numeric session id against the room's string one", () => {
    // Pandora ids are strings everywhere in the room state and a number on the
    // feed row; comparing them raw would never match.
    const out = briefedFromRoomsBySession(row, rooms({ blue: room({ sessionId: "58996064" }) }));
    expect(out?.briefedRoom).toBe("blue");
  });

  it("leaves a heat no room is holding alone", () => {
    const out = briefedFromRoomsBySession(row, rooms({ red: room({ sessionId: "58996065" }) }));
    expect(out).toBe(row);
  });

  it("never overrides the server's own marker", () => {
    // The full feed has spoken; a room's clock must not restate the send time.
    const marked = { ...row, briefedAtMs: SENT_AT - 60_000, briefedRoom: "blue" as const };
    expect(briefedFromRoomsBySession(marked, rooms({ red: room() }))).toBe(marked);
  });

  it("ignores a room whose film has been STARTED", () => {
    // triggeredAtMs becomes the START time then, and reading it would re-fire
    // the "proceed to the RED room" announcement minutes after the walk over.
    const out = briefedFromRoomsBySession(
      row,
      rooms({ red: room({ kind: "timeline", triggeredAtMs: SENT_AT + 300_000 }) }),
    );
    expect(out).toBe(row);
  });

  it("survives rooms it could not read at all", () => {
    expect(briefedFromRoomsBySession(row, null)).toBe(row);
  });

  it("is a no-op on a board with no heat", () => {
    expect(briefedFromRoomsBySession(null, rooms({ red: room() }))).toBeNull();
    const noSession = { ...row, sessionId: null };
    expect(briefedFromRoomsBySession(noSession, rooms({ red: room() }))).toBe(noSession);
  });
});

describe("briefedFromRoomsByHeat — the guide wall's rows", () => {
  const guide = (over: Partial<{ track: string; heatNumber: number | null }> = {}) => ({
    track: "blue",
    heatNumber: 56,
    briefedAtMs: null as number | null,
    briefedRoom: null as "red" | "blue" | null,
    ...over,
  });

  it("marks the sent heat without needing an id the wall is not allowed to carry", () => {
    const out = briefedFromRoomsByHeat([guide()], rooms({ blue: room() }));
    expect(out[0].briefedAtMs).toBe(SENT_AT);
    expect(out[0].briefedRoom).toBe("blue");
  });

  it("does not mark the same heat NUMBER on the other track", () => {
    // Heat numbers are per-track: blue 56 and red 56 are different heats.
    const rows = [guide({ track: "red" })];
    const out = briefedFromRoomsByHeat(rows, rooms({ blue: room({ track: "blue" }) }));
    expect(out[0]).toBe(rows[0]);
  });

  it("marks a mega heat when the room is holding the mega session", () => {
    const out = briefedFromRoomsByHeat(
      [guide({ track: "mega" })],
      rooms({ red: room({ track: "mega" }) }),
    );
    expect(out[0].briefedRoom).toBe("red");
  });

  it("leaves the other track's row working when one is sent", () => {
    const rows = [guide(), guide({ track: "red", heatNumber: 22 })];
    const out = briefedFromRoomsByHeat(rows, rooms({ blue: room() }));
    expect(out[0].briefedAtMs).toBe(SENT_AT);
    expect(out[1]).toBe(rows[1]);
  });

  it("returns the rows untouched when no room is holding anything", () => {
    const rows = [guide()];
    expect(briefedFromRoomsByHeat(rows, rooms())).toBe(rows);
    expect(briefedFromRoomsByHeat(rows, null)).toBe(rows);
  });
});
