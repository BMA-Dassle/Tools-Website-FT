import { describe, it, expect } from "vitest";
import {
  ARENA_ACTIVITY_ACCENTS,
  ARENA_ACTIVITY_DESTINATIONS,
  ARENA_ACTIVITY_LABELS,
  ARENA_HOLD_DEFAULT_MS,
  ARENA_HOLD_MAX_MS,
  ARENA_HOLD_MIN_MS,
  activeArenaCalls,
  arenaCheckinRemainingMs,
  arenaTakeoverStartMs,
  clampArenaHoldMs,
  classifyArenaBoardSession,
  formatArenaCountdown,
  type ArenaCall,
} from "./arena-board";

const NOW = 1_756_700_000_000;

function call(over: Partial<ArenaCall> = {}): ArenaCall {
  return {
    sessionId: "1001",
    activity: "laser-tag",
    heatNumber: 25,
    scheduledStart: null,
    calledAtMs: NOW,
    ...over,
  };
}

describe("classifyArenaBoardSession", () => {
  // Every string below is one Pandora actually returned. A 30-day sweep of both
  // HeadPinz venues on 2026-09-01 found exactly four distinct `type` values at
  // Fort Myers across 494 sessions, and two at Naples across 26.
  it("reads the two ordinary cases — 96% of what the arena runs", () => {
    expect(classifyArenaBoardSession("Laser Tag")).toBe("laser-tag");
    expect(classifyArenaBoardSession("Gel Blaster")).toBe("gel-blaster");
    expect(classifyArenaBoardSession("25 - Nexus Laser Tag")).toBe("laser-tag");
    expect(classifyArenaBoardSession("53 - Nexus Gel Blaster")).toBe("gel-blaster");
  });

  it("reads 'Nexus LaserTag' — the unspaced spelling the SMS classifier drops", () => {
    // 4 of 494 at Fort Myers. The cron's `includes("laser tag")` misses this, so
    // those sessions get no check-in text; the board must not lose them too.
    expect(classifyArenaBoardSession("Nexus LaserTag")).toBe("laser-tag");
    expect(classifyArenaBoardSession("Nexus GelBlaster")).toBe("gel-blaster");
  });

  it("refuses to guess when a session names BOTH games", () => {
    // 10 of 494 — birthday parties that decide on the day. The cron tests laser
    // tag first and answers "laser-tag"; on a wall that is an instruction to walk
    // to the wrong half of the arena.
    expect(classifyArenaBoardSession("- Gel Blaster or Laser Tag")).toBe("either");
    expect(classifyArenaBoardSession("28 - Birthday - Gel Blaster or Laser Tag")).toBe("either");
  });

  it("is null for anything that names neither game", () => {
    expect(classifyArenaBoardSession("Private Hire")).toBeNull();
    expect(classifyArenaBoardSession("")).toBeNull();
    expect(classifyArenaBoardSession(null)).toBeNull();
    expect(classifyArenaBoardSession(undefined)).toBeNull();
  });
});

describe("board identity", () => {
  it("has a label, an accent and a destination for every kind — including 'either'", () => {
    // A missing entry would render `undefined` eight feet tall.
    for (const kind of ["laser-tag", "gel-blaster", "either"] as const) {
      expect(ARENA_ACTIVITY_LABELS[kind]).toBeTruthy();
      expect(ARENA_ACTIVITY_ACCENTS[kind]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(ARENA_ACTIVITY_DESTINATIONS[kind]).toBeTruthy();
    }
  });

  it("sends an ambiguous booking to the arena desk, not to one game's desk", () => {
    expect(ARENA_ACTIVITY_DESTINATIONS.either).not.toMatch(/laser|gel/i);
  });

  it("does not dress an ambiguous booking in either game's colour", () => {
    expect(ARENA_ACTIVITY_ACCENTS.either).not.toBe(ARENA_ACTIVITY_ACCENTS["laser-tag"]);
    expect(ARENA_ACTIVITY_ACCENTS.either).not.toBe(ARENA_ACTIVITY_ACCENTS["gel-blaster"]);
  });
});

describe("clampArenaHoldMs", () => {
  it("defaults anything unusable — this decides how long an instruction sits on a wall", () => {
    expect(clampArenaHoldMs(undefined)).toBe(ARENA_HOLD_DEFAULT_MS);
    expect(clampArenaHoldMs(null)).toBe(ARENA_HOLD_DEFAULT_MS);
    expect(clampArenaHoldMs("10")).toBe(ARENA_HOLD_DEFAULT_MS);
    expect(clampArenaHoldMs(NaN)).toBe(ARENA_HOLD_DEFAULT_MS);
    expect(clampArenaHoldMs(Infinity)).toBe(ARENA_HOLD_DEFAULT_MS);
  });

  it("clamps both ends, so a fat-fingered value cannot pin the board all evening", () => {
    expect(clampArenaHoldMs(0)).toBe(ARENA_HOLD_MIN_MS);
    expect(clampArenaHoldMs(-1)).toBe(ARENA_HOLD_MIN_MS);
    expect(clampArenaHoldMs(60 * 60_000)).toBe(ARENA_HOLD_MAX_MS);
  });

  it("passes a sane value straight through", () => {
    expect(clampArenaHoldMs(5 * 60_000)).toBe(5 * 60_000);
  });
});

describe("activeArenaCalls", () => {
  it("keeps a call inside the hold window and drops it after", () => {
    const hold = 10 * 60_000;
    const c = call({ calledAtMs: NOW - 9 * 60_000 });
    expect(activeArenaCalls([c], NOW, hold)).toHaveLength(1);
    expect(activeArenaCalls([c], NOW + 2 * 60_000, hold)).toHaveLength(0);
  });

  it("shows BOTH activities at once — the normal case at Fort Myers, not an edge", () => {
    const laser = call({ sessionId: "1", activity: "laser-tag", calledAtMs: NOW - 60_000 });
    const gel = call({ sessionId: "2", activity: "gel-blaster", calledAtMs: NOW - 10_000 });
    const active = activeArenaCalls([laser, gel], NOW, ARENA_HOLD_DEFAULT_MS);
    expect(active.map((c) => c.activity)).toEqual(["gel-blaster", "laser-tag"]);
  });

  it("keeps only the NEWEST call per activity — the desk has moved on from the last one", () => {
    const old = call({ sessionId: "1", heatNumber: 25, calledAtMs: NOW - 5 * 60_000 });
    const fresh = call({ sessionId: "2", heatNumber: 26, calledAtMs: NOW - 30_000 });
    const active = activeArenaCalls([old, fresh], NOW, ARENA_HOLD_DEFAULT_MS);
    expect(active).toHaveLength(1);
    expect(active[0].heatNumber).toBe(26);
  });

  it("drops a future-stamped call — clock skew is not a reason to instruct a group", () => {
    const skewed = call({ calledAtMs: NOW + 60_000 });
    expect(activeArenaCalls([skewed], NOW, ARENA_HOLD_DEFAULT_MS)).toHaveLength(0);
  });

  it("tolerates a few seconds of round-trip, which is not skew", () => {
    const justAhead = call({ calledAtMs: NOW + 2_000 });
    expect(activeArenaCalls([justAhead], NOW, ARENA_HOLD_DEFAULT_MS)).toHaveLength(1);
  });

  it("orders totally, so two boards in one building cannot lay the panels out differently", () => {
    const a = call({ sessionId: "aaa", activity: "laser-tag", calledAtMs: NOW });
    const b = call({ sessionId: "bbb", activity: "gel-blaster", calledAtMs: NOW });
    const forwards = activeArenaCalls([a, b], NOW, ARENA_HOLD_DEFAULT_MS);
    const backwards = activeArenaCalls([b, a], NOW, ARENA_HOLD_DEFAULT_MS);
    expect(forwards.map((c) => c.sessionId)).toEqual(backwards.map((c) => c.sessionId));
    expect(forwards.map((c) => c.sessionId)).toEqual(["aaa", "bbb"]);
  });

  it("clamps the hold it is given, so a bad config cannot widen the window", () => {
    const ancient = call({ calledAtMs: NOW - 45 * 60_000 });
    expect(activeArenaCalls([ancient], NOW, 60 * 60_000)).toHaveLength(0);
  });

  it("is empty for an empty feed", () => {
    expect(activeArenaCalls([], NOW, ARENA_HOLD_DEFAULT_MS)).toEqual([]);
  });

  it("carries a birthday alongside both games — three is the ceiling, and reachable", () => {
    const active = activeArenaCalls(
      [
        call({ sessionId: "1", activity: "laser-tag", calledAtMs: NOW - 120_000 }),
        call({ sessionId: "2", activity: "gel-blaster", calledAtMs: NOW - 60_000 }),
        call({ sessionId: "3", activity: "either", calledAtMs: NOW - 10_000 }),
      ],
      NOW,
      ARENA_HOLD_DEFAULT_MS,
    );
    expect(active).toHaveLength(3);
    // Newest first, so the group that has just been called reads leftmost.
    expect(active.map((c) => c.activity)).toEqual(["either", "gel-blaster", "laser-tag"]);
  });

  it("never exceeds three — one per kind, and there are three kinds", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      call({
        sessionId: String(i),
        activity: (["laser-tag", "gel-blaster", "either"] as const)[i % 3],
        calledAtMs: NOW - i * 1_000,
      }),
    );
    expect(activeArenaCalls(many, NOW, ARENA_HOLD_DEFAULT_MS).length).toBeLessThanOrEqual(3);
  });
});

describe("arenaTakeoverStartMs", () => {
  it("anchors on the EARLIEST call, so a second activity joins without remounting", () => {
    const first = call({ sessionId: "1", activity: "laser-tag", calledAtMs: NOW - 4 * 60_000 });
    const second = call({ sessionId: "2", activity: "gel-blaster", calledAtMs: NOW });
    const before = arenaTakeoverStartMs(activeArenaCalls([first], NOW, ARENA_HOLD_DEFAULT_MS));
    const after = arenaTakeoverStartMs(
      activeArenaCalls([first, second], NOW, ARENA_HOLD_DEFAULT_MS),
    );
    expect(after).toBe(before);
  });

  it("is null with nothing live — the caller's signal that there is no takeover", () => {
    expect(arenaTakeoverStartMs([])).toBeNull();
  });
});

describe("arenaCheckinRemainingMs", () => {
  it("counts down from the CALL, not from the scheduled start", () => {
    const c = call({ calledAtMs: NOW - 2 * 60_000 });
    expect(arenaCheckinRemainingMs(c, NOW, 8)).toBe(6 * 60_000);
  });

  it("floors at zero — staff will still check somebody in at 8:01", () => {
    const c = call({ calledAtMs: NOW - 20 * 60_000 });
    expect(arenaCheckinRemainingMs(c, NOW, 8)).toBe(0);
  });
});

describe("formatArenaCountdown", () => {
  it("pads the seconds", () => {
    expect(formatArenaCountdown(6 * 60_000 + 5_000)).toBe("6:05");
    expect(formatArenaCountdown(42_000)).toBe("0:42");
  });

  it("never renders a negative", () => {
    expect(formatArenaCountdown(-5_000)).toBe("0:00");
  });
});
