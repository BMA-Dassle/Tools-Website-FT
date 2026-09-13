import { describe, expect, it } from "vitest";
import { laneSignature, mergeBoardPulse, type BoardPulse } from "./board-pulse";
import type { BoardStatus } from "./useBriefingControl";
import type { PitLanes } from "~/features/signage/pit/pit-board";
import type { CrewBoard } from "~/features/staff/crew-list";

const EMPTY_LANE = { holding: null, karts: null, racing: null, pitIn: null };

function lanes(over: Partial<Record<"blue" | "red" | "mega", Record<string, unknown>>> = {}) {
  return {
    blue: { ...EMPTY_LANE, ...(over.blue ?? {}) },
    red: { ...EMPTY_LANE, ...(over.red ?? {}) },
    mega: { ...EMPTY_LANE, ...(over.mega ?? {}) },
  } as unknown as PitLanes;
}

function crew(names: string[]): CrewBoard {
  return {
    list: names.map((firstName, i) => ({
      userId: i + 1,
      firstName,
      briefed: 0,
      race: null,
      freeSinceMs: null,
      state: "available",
      top: false,
    })),
    unattributed: 0,
    groups: 0,
    briefers: 0,
    rosterAvailable: true,
  };
}

function board(over: Partial<BoardStatus> = {}): BoardStatus {
  return {
    now: 1_000,
    businessDay: "2026-09-12",
    enabled: true,
    rooms: [
      {
        room: "red",
        state: null,
        phase: "idle",
        nextInMs: null,
        groupOut: { sessionId: "s-old", heatNumber: 30, room: "red" } as never,
        host: null,
      },
      {
        room: "blue",
        state: null,
        phase: "idle",
        nextInMs: null,
        groupOut: null,
        host: null,
      },
    ],
    checkinWindowMins: { blue: 8, red: 8, mega: 8 },
    assignments: [],
    videos: { starter: null, intermediate: null, pro: null },
    helmetPosterUrl: null,
    briefings: [],
    lanes: lanes({ blue: { pitIn: { sessionId: "s-41", heatNumber: 41 } } }),
    crew: crew(["Pedro"]),
    ...over,
  };
}

function pulse(over: Partial<BoardPulse> = {}): BoardPulse {
  return {
    now: 2_000,
    rooms: [
      { room: "red", state: null, phase: "idle", nextInMs: null, host: null },
      {
        room: "blue",
        state: { kind: "assigned", sessionId: "s-42", track: "blue" } as never,
        phase: "waiting",
        nextInMs: null,
        host: "Ana",
      },
    ],
    lanes: lanes(),
    crew: crew(["Ana", "Pedro"]),
    ...over,
  };
}

describe("mergeBoardPulse", () => {
  it("no board → nothing to merge onto", () => {
    expect(mergeBoardPulse(null, pulse())).toBeNull();
  });

  it("no pulse → the board as it was", () => {
    const b = board();
    expect(mergeBoardPulse(b, null)).toBe(b);
    expect(mergeBoardPulse(b, undefined)).toBe(b);
  });

  it("a newer pulse replaces rooms, lanes and crew — the post press frees the marshal at once", () => {
    const merged = mergeBoardPulse(board(), pulse())!;
    expect(merged.now).toBe(2_000);
    // The lane's pitIn was emptied by the post; the strip lists Ana as available.
    expect(merged.lanes?.blue.pitIn).toBeNull();
    expect(merged.crew?.list.map((e) => e.firstName)).toEqual(["Ana", "Pedro"]);
    // Rooms take the pulse's live fields…
    const blue = merged.rooms.find((r) => r.room === "blue")!;
    expect(blue.phase).toBe("waiting");
    expect(blue.host).toBe("Ana");
    expect(blue.state?.sessionId).toBe("s-42");
  });

  it("carries the Ready to pull marks, and keeps the board's when a pulse lacks them", () => {
    const b = board({
      readyToPull: { blue: { sessionId: "s-41", atMs: 1 }, red: null, mega: null },
    });
    const withMark = mergeBoardPulse(
      b,
      pulse({ readyToPull: { blue: null, red: { sessionId: "s-9", atMs: 2 }, mega: null } }),
    )!;
    expect(withMark.readyToPull?.red?.sessionId).toBe("s-9");
    expect(withMark.readyToPull?.blue).toBeNull();
    expect(mergeBoardPulse(b, pulse())!.readyToPull).toBe(b.readyToPull);
  });

  it("…but keep groupOut from the full board, which the pulse does not read", () => {
    const merged = mergeBoardPulse(board(), pulse())!;
    const red = merged.rooms.find((r) => r.room === "red")!;
    expect(red.groupOut).toEqual({ sessionId: "s-old", heatNumber: 30, room: "red" });
  });

  it("an OLDER pulse never overwrites a board a press just reloaded", () => {
    const fresh = board({ now: 5_000 });
    expect(mergeBoardPulse(fresh, pulse({ now: 4_999 }))).toBe(fresh);
    expect(mergeBoardPulse(fresh, pulse({ now: 5_000 }))).toBe(fresh);
  });

  it("a room the pulse does not carry is left as the full board had it", () => {
    const merged = mergeBoardPulse(
      board(),
      pulse({ rooms: [{ room: "red", state: null, phase: "idle", nextInMs: null, host: "Bo" }] }),
    )!;
    expect(merged.rooms.find((r) => r.room === "red")!.host).toBe("Bo");
    expect(merged.rooms.find((r) => r.room === "blue")).toEqual(board().rooms[1]);
  });

  it("does not disturb the slow half of the board", () => {
    const b = board({
      assignments: [{ id: "a1" } as never],
      briefings: [{ sessionId: "x" } as never],
    });
    const merged = mergeBoardPulse(b, pulse())!;
    expect(merged.assignments).toBe(b.assignments);
    expect(merged.briefings).toBe(b.briefings);
    expect(merged.checkinWindowMins).toBe(b.checkinWindowMins);
  });
});

describe("laneSignature", () => {
  it("is empty for no lanes and for empty lanes", () => {
    expect(laneSignature(null)).toBe("");
    expect(laneSignature(undefined)).toBe("");
    expect(laneSignature(lanes())).toBe("");
  });

  it("names every occupied slot in a fixed order", () => {
    const sig = laneSignature(
      lanes({
        red: { racing: { sessionId: "r-9" } },
        blue: { holding: { sessionId: "b-1" }, pitIn: { sessionId: "b-0" } },
      }),
    );
    expect(sig).toBe("blue:holding:b-1|blue:pitIn:b-0|red:racing:r-9");
  });

  it("changes when a race is posted (pitIn empties) — the cue to refetch the wait times", () => {
    const before = laneSignature(lanes({ blue: { pitIn: { sessionId: "b-0" } } }));
    const after = laneSignature(lanes());
    expect(before).not.toBe(after);
  });

  it("is stable across two reads of the same floor", () => {
    const a = lanes({ red: { karts: { sessionId: "r-2", heatNumber: 2 } } });
    const b = lanes({ red: { karts: { sessionId: "r-2", heatNumber: 2, atMs: 123 } } });
    expect(laneSignature(a)).toBe(laneSignature(b));
  });
});
