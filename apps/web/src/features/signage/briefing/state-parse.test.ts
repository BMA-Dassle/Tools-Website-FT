import { describe, expect, it } from "vitest";
import { BRIEFING_ROOM_KINDS, parseBriefingRoomState } from "./state-parse";
import type { BriefingRoomState } from "./types";

/**
 * THE BUG THIS FILE EXISTS FOR (2026-08-11).
 *
 * `assigned` was added to BriefingRoomState and to the writer, but not to the
 * runtime guard in the reader. Every send was written to Redis, read straight back
 * as unparseable, and the room reported "Empty" — so pressing Send appeared to do
 * nothing while the durable row and the success toast both said it had worked. The
 * type system could not catch it: the guard was narrowing a `string`, so dropping a
 * member is invisible to tsc.
 *
 * The list is now exported as a const and iterated here, so adding a kind without
 * teaching the parser fails a test instead of a briefing room.
 */
function valid(over: Partial<BriefingRoomState> = {}): BriefingRoomState {
  return {
    kind: "assigned",
    tier: "starter",
    track: "red",
    raceType: "Starter",
    sessionId: "57885962",
    heatNumber: 13,
    triggeredAtMs: 1_760_000_000_000,
    videoUrl: "https://blob.test/starter.mp4",
    videoDurationMs: 240_000,
    ...over,
  };
}

describe("parseBriefingRoomState", () => {
  it("round-trips EVERY kind — the guard cannot silently drop one", () => {
    for (const kind of BRIEFING_ROOM_KINDS) {
      const parsed = parseBriefingRoomState(JSON.stringify(valid({ kind })));
      expect(parsed, `kind "${kind}" must survive a round-trip`).not.toBeNull();
      expect(parsed?.kind).toBe(kind);
    }
  });

  it("keeps the fields the boards actually read", () => {
    const parsed = parseBriefingRoomState(JSON.stringify(valid()));
    expect(parsed).toMatchObject({
      kind: "assigned",
      tier: "starter",
      track: "red",
      raceType: "Starter",
      sessionId: "57885962",
      heatNumber: 13,
      videoDurationMs: 240_000,
    });
  });

  it("rejects an unknown kind rather than half-honouring it", () => {
    // Deliberately strict, unlike screen config: a half-understood briefing state
    // could play the wrong safety film, so idle is the safer answer.
    expect(parseBriefingRoomState(JSON.stringify(valid({ kind: "banana" as never })))).toBeNull();
  });

  it("rejects a state with no usable clock", () => {
    expect(
      parseBriefingRoomState(JSON.stringify(valid({ triggeredAtMs: undefined as never }))),
    ).toBeNull();
    expect(
      parseBriefingRoomState(JSON.stringify(valid({ triggeredAtMs: "soon" as never }))),
    ).toBeNull();
  });

  it("is null for junk, empty and missing input", () => {
    expect(parseBriefingRoomState(null)).toBeNull();
    expect(parseBriefingRoomState("")).toBeNull();
    expect(parseBriefingRoomState("not json")).toBeNull();
  });

  it("normalises an unrecognised track and tier instead of failing the state", () => {
    const parsed = parseBriefingRoomState(
      JSON.stringify(valid({ track: "purple" as never, tier: "expert" as never })),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.track).toBe("mega");
    expect(parsed?.tier).toBeNull();
  });
});
