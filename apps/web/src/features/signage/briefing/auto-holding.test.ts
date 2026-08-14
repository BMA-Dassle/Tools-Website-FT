import { describe, expect, it } from "vitest";
import { autoHoldingDecision, MAX_ELIGIBLE_AGE_MS, type RoomMotion } from "./auto-holding";
import { HELMET_PHASE_MS, type BriefingRoomState } from "./types";

const VIDEO_MS = 4 * 60_000;
const START = 1_700_000_000_000;
/** The first instant the sweep is allowed to act: film done AND helmet board run. */
const ELIGIBLE = START + VIDEO_MS + HELMET_PHASE_MS;

function room(over: Partial<BriefingRoomState> = {}): BriefingRoomState {
  return {
    kind: "timeline",
    tier: "starter",
    track: "blue",
    raceType: "Starter",
    sessionId: "58569572",
    heatNumber: 29,
    triggeredAtMs: START,
    videoUrl: "https://blob/starter.mp4",
    videoDurationMs: VIDEO_MS,
    ...over,
  };
}

/** The refusal reason, or a failed assertion if it decided to move. Keeps the
 *  narrowing in one place instead of an `if (!v.move)` around every check. */
function whyNot(v: ReturnType<typeof autoHoldingDecision>): string {
  if (v.move) throw new Error("expected a refusal, got a move");
  return v.why;
}

function decide(over: {
  nowMs?: number;
  state?: BriefingRoomState | null;
  motion?: RoomMotion;
  holdingSessionId?: string | null;
  enabled?: boolean;
}) {
  return autoHoldingDecision({
    nowMs: over.nowMs ?? ELIGIBLE + 1_000,
    state: over.state === undefined ? room() : over.state,
    motion: over.motion ?? "quiet",
    holdingSessionId: over.holdingSessionId ?? null,
    enabled: over.enabled ?? true,
  });
}

describe("autoHoldingDecision", () => {
  it("moves a quiet room once the film and the helmet board are done", () => {
    const v = decide({});
    expect(v.move).toBe(true);
    if (v.move) {
      expect(v.sessionId).toBe("58569572");
      expect(v.heatNumber).toBe(29);
      expect(v.raceType).toBe("Starter");
    }
  });

  it("is off when the board's switch is off", () => {
    expect(decide({ enabled: false })).toEqual({ move: false, why: "switched off" });
  });

  it("does nothing to an idle room", () => {
    expect(decide({ state: null }).move).toBe(false);
  });

  it("will not touch a group still walking over", () => {
    const v = decide({ state: room({ kind: "assigned" }), nowMs: START + 60_000 });
    expect(v).toEqual({ move: false, why: "film not started" });
  });

  /**
   * THE FAILURE THIS GATE EXISTS FOR. A group sits still to watch a safety film,
   * so a quiet room mid-film is a watching room, not an empty one.
   */
  it("never fires while the film is playing, however quiet the room is", () => {
    expect(whyNot(decide({ nowMs: START + VIDEO_MS - 1_000, motion: "quiet" }))).toContain(
      "film still running",
    );
  });

  it("waits out the helmet board before believing a quiet room", () => {
    expect(whyNot(decide({ nowMs: START + VIDEO_MS + 5_000, motion: "quiet" }))).toContain(
      "helmet board still up",
    );
  });

  it("fires the instant the helmet board has had its full run", () => {
    expect(decide({ nowMs: ELIGIBLE }).move).toBe(true);
  });

  /**
   * THE BUG THIS PREVENTS. The Nx relay intermittently answers 200 with an empty
   * body; parsed leniently that is "no motion", which would empty every room at
   * once. `unknown` must never be treated as quiet.
   */
  it("treats an unreadable camera answer as an occupied room", () => {
    expect(decide({ motion: "unknown" })).toEqual({ move: false, why: "no camera answer" });
  });

  it("leaves a busy room alone", () => {
    expect(decide({ motion: "motion" })).toEqual({ move: false, why: "room still busy" });
  });

  /**
   * sendToHolding DISPLACES whoever is in the holding slot into `racing`. Getting
   * that wrong tells the pit board a group is on track who is still in the seats,
   * so when the slot belongs to somebody else this defers to a human.
   */
  it("refuses when another session already holds the pit seats", () => {
    expect(whyNot(decide({ holdingSessionId: "99999999" }))).toContain("99999999");
  });

  it("is happy to re-decide for the session already holding", () => {
    expect(decide({ holdingSessionId: "58569572" }).move).toBe(true);
  });

  it("gives up on a room nobody closed, rather than firing hours later", () => {
    expect(whyNot(decide({ nowMs: ELIGIBLE + MAX_ELIGIBLE_AGE_MS + 60_000 }))).toContain(
      "too long after the film",
    );
  });

  it("still fires just inside the give-up window", () => {
    expect(decide({ nowMs: ELIGIBLE + MAX_ELIGIBLE_AGE_MS - 60_000 }).move).toBe(true);
  });

  /** A send that went out before any film was uploaded opens on the helmet board,
   *  so its timeline is helmet-from-zero and the gate is just the helmet phase. */
  it("handles a briefing that never had a film", () => {
    const noFilm = room({ videoUrl: null, videoDurationMs: null });
    expect(decide({ state: noFilm, nowMs: START + 5_000 }).move).toBe(false);
    expect(decide({ state: noFilm, nowMs: START + HELMET_PHASE_MS + 1_000 }).move).toBe(true);
  });

  /** videoDurationMs missing on a real film falls back to the nominal length in
   *  phase.ts — the gate must follow that, not assume zero. */
  it("uses the nominal film length when the duration was never captured", () => {
    const unknownLength = room({ videoDurationMs: null });
    expect(decide({ state: unknownLength, nowMs: START + 60_000 }).move).toBe(false);
    expect(decide({ state: unknownLength, nowMs: START + 6 * 60_000 }).move).toBe(true);
  });

  it("refuses a state with no session id rather than moving a phantom", () => {
    expect(decide({ state: room({ sessionId: "" }) })).toEqual({
      move: false,
      why: "no session in the room",
    });
  });
});
