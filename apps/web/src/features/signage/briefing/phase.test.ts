import { describe, expect, it } from "vitest";
import { briefingReadyForHolding, briefingStateTtlSeconds, briefingTimelineAt } from "./phase";
import {
  ASSIGNED_HOLD_MS,
  HELMET_PHASE_MS,
  NOMINAL_VIDEO_MS,
  type BriefingRoomState,
} from "./types";

const VIDEO_MS = 4 * 60_000; // a four-minute briefing film
const T0 = 1_760_000_000_000;

function state(over: Partial<BriefingRoomState> = {}): BriefingRoomState {
  return {
    kind: "timeline",
    tier: "starter",
    track: "red",
    raceType: "Starter",
    sessionId: "60",
    heatNumber: 60,
    triggeredAtMs: T0,
    videoUrl: "https://example.test/starter.mp4",
    videoDurationMs: VIDEO_MS,
    ...over,
  };
}

describe("briefingTimelineAt", () => {
  it("is idle with no state — the room shows its helmet board", () => {
    expect(briefingTimelineAt(null, T0).phase).toBe("idle");
    expect(briefingTimelineAt(undefined, T0).phase).toBe("idle");
  });

  it("plays the video from the send, and seeks to the elapsed offset", () => {
    expect(briefingTimelineAt(state(), T0).phase).toBe("video");
    const mid = briefingTimelineAt(state(), T0 + 90_000);
    expect(mid.phase).toBe("video");
    expect(mid.videoOffsetMs).toBe(90_000);
    expect(mid.nextInMs).toBe(VIDEO_MS - 90_000);
  });

  it("shows helmet sizes the moment the film ends", () => {
    expect(briefingTimelineAt(state(), T0 + VIDEO_MS).phase).toBe("helmet");
    expect(briefingTimelineAt(state(), T0 + VIDEO_MS + 29_000).phase).toBe("helmet");
  });

  it("HOLDS ON HELMETS UNTIL A HUMAN MOVES THEM — no auto-complete", () => {
    /**
     * Owner 2026-08-14: "don't auto complete that section… there shouldn't be
     * any auto moving to holding. I think when briefing done it does some 30
     * second helmet countdown then goes to limbo."
     *
     * This REPLACES the old rule ("once the helmet portion is done this should
     * clear and be ready for the next", 2026-08-11), which predates the holding
     * step. Falling to idle 30s after the film took the desk's "Send to holding"
     * control down with it, stranding a group who were still in the room.
     *
     * A room now empties on a press — send to holding, Undo, or a replacing
     * send — and never on a clock. The Redis TTL is the only backstop.
     */
    const filmEnd = T0 + VIDEO_MS;
    for (const after of [HELMET_PHASE_MS, 60_000, 10 * 60_000, 40 * 60_000]) {
      const t = briefingTimelineAt(state(), filmEnd + after);
      expect(t.phase).toBe("helmet");
      // Nothing follows on a clock, so there is no countdown to publish.
      expect(t.nextInMs).toBeNull();
    }
  });

  it("REBOOT REJOINS: a player restarting mid-film comes back mid-film", () => {
    // The whole point of deriving from a timestamp — the player has no memory,
    // so this is the same call the fresh tab makes on its first frame.
    const rejoin = briefingTimelineAt(state(), T0 + 3 * 60_000);
    expect(rejoin.phase).toBe("video");
    expect(rejoin.videoOffsetMs).toBe(3 * 60_000);
  });

  it("skips the video entirely when no film is uploaded", () => {
    const noVideo = state({ videoUrl: null, videoDurationMs: null });
    // Straight to helmet sizes rather than a black screen for five minutes —
    // and it stays there, like any other finished briefing.
    expect(briefingTimelineAt(noVideo, T0).phase).toBe("helmet");
    expect(briefingTimelineAt(noVideo, T0 + HELMET_PHASE_MS).phase).toBe("helmet");
  });

  it("falls back to a nominal length when duration is unknown", () => {
    const unknown = state({ videoDurationMs: null });
    expect(briefingTimelineAt(unknown, T0 + NOMINAL_VIDEO_MS - 1).phase).toBe("video");
    expect(briefingTimelineAt(unknown, T0 + NOMINAL_VIDEO_MS).phase).toBe("helmet");
  });

  it("treats a future-stamped send as starting now (writer clock skew)", () => {
    // A room with a group standing in it must play the video, not wait out a
    // clock difference between the control PC and the player.
    const skewed = briefingTimelineAt(state({ triggeredAtMs: T0 + 30_000 }), T0);
    expect(skewed.phase).toBe("video");
    expect(skewed.videoOffsetMs).toBe(0);
  });

  it("is idle for a nonsense timestamp rather than throwing", () => {
    expect(briefingTimelineAt(state({ triggeredAtMs: NaN }), T0).phase).toBe("idle");
  });
});

describe("the two-phase send", () => {
  it("HOLDS on the take-a-seat board when assigned, and never auto-starts", () => {
    // The whole reason phase two exists: a group walks over. Rolling the film at
    // send time meant the first arrivals watched the opening alone.
    const assigned = state({ kind: "assigned" });
    expect(briefingTimelineAt(assigned, T0).phase).toBe("waiting");
    expect(briefingTimelineAt(assigned, T0 + 60_000).phase).toBe("waiting");
    expect(briefingTimelineAt(assigned, T0 + 10 * 60_000).phase).toBe("waiting");
    // No countdown — it is waiting on a person, not a clock.
    expect(briefingTimelineAt(assigned, T0 + 60_000).nextInMs).toBeNull();
  });

  it("gives up on an assignment nobody ever started", () => {
    const assigned = state({ kind: "assigned" });
    expect(briefingTimelineAt(assigned, T0 + ASSIGNED_HOLD_MS - 1).phase).toBe("waiting");
    expect(briefingTimelineAt(assigned, T0 + ASSIGNED_HOLD_MS).phase).toBe("idle");
  });

  it("STARTING re-stamps the clock, so the film begins from the top", () => {
    // What the service does on Start: same session, fresh triggeredAtMs. The
    // waiting time before it must not count against the video.
    const startedAt = T0 + 8 * 60_000; // they took eight minutes to sit down
    const started = state({ kind: "timeline", triggeredAtMs: startedAt });
    expect(briefingTimelineAt(started, startedAt).phase).toBe("video");
    expect(briefingTimelineAt(started, startedAt).videoOffsetMs).toBe(0);
    expect(briefingTimelineAt(started, startedAt + 60_000).videoOffsetMs).toBe(60_000);
  });

  it("RESTART is the same shape — a later stamp rewinds the room", () => {
    // Latecomers, or "can we see that again?". Restart is start with a new stamp,
    // so the room is back at 0:00 with the full timeline ahead of it.
    const restartedAt = T0 + 30 * 60_000;
    const restarted = state({ kind: "timeline", triggeredAtMs: restartedAt });
    const t = briefingTimelineAt(restarted, restartedAt + 1_000);
    expect(t.phase).toBe("video");
    expect(t.videoOffsetMs).toBe(1_000);
    expect(t.nextInMs).toBe(VIDEO_MS - 1_000);
  });

  it("reports time remaining, which is what the board counts down", () => {
    const t = briefingTimelineAt(state(), T0 + 60_000);
    expect(t.nextInMs).toBe(VIDEO_MS - 60_000);
  });
});

describe("briefingStateTtlSeconds", () => {
  it("holds an assignment's key past the hold window", () => {
    const ttlMs = briefingStateTtlSeconds(state({ kind: "assigned" })) * 1000;
    expect(ttlMs).toBeGreaterThan(ASSIGNED_HOLD_MS);
  });

  it("outlives the whole timeline", () => {
    const ttlMs = briefingStateTtlSeconds(state()) * 1000;
    expect(ttlMs).toBeGreaterThan(VIDEO_MS + HELMET_PHASE_MS);
  });

  it("scales with a longer film", () => {
    const short = briefingStateTtlSeconds(state({ videoDurationMs: 60_000 }));
    const long = briefingStateTtlSeconds(state({ videoDurationMs: 20 * 60_000 }));
    expect(long).toBeGreaterThan(short);
  });
});

/**
 * THE FILM IS A GATE (owner 2026-08-15: "Briefing tablets are allowing to send
 * to holding before video is done"). Every case is driven through the real
 * timeline rather than a hand-built phase, so the gate cannot pass a state the
 * arithmetic never produces.
 */
describe("briefingReadyForHolding", () => {
  const at = (ms: number, over: Partial<BriefingRoomState> = {}) =>
    briefingReadyForHolding(briefingTimelineAt(state(over), ms));

  it("refuses while the film is running — start, middle, and the last second", () => {
    for (const ms of [T0, T0 + 90_000, T0 + VIDEO_MS - 1]) {
      const verdict = at(ms);
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.reason).toBe("video-playing");
    }
  });

  it("allows the send the moment the film ends", () => {
    expect(at(T0 + VIDEO_MS).ok).toBe(true);
    expect(at(T0 + VIDEO_MS + HELMET_PHASE_MS).ok).toBe(true);
  });

  it("refuses a briefing nobody started", () => {
    const verdict = at(T0, { kind: "assigned" });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("not-started");
  });

  /**
   * A FILM THAT DOES NOT EXIST CANNOT BLOCK ANYONE. Staff send briefings before
   * anybody has uploaded the video; the timeline puts those straight into the
   * helmet phase, and this must not turn that into a room with no way out.
   */
  it("allows the send when there is no video at all", () => {
    expect(at(T0, { videoUrl: null }).ok).toBe(true);
  });

  /** A timed-out assignment may still have people standing in the room — see
   *  the note on the rule. Refusing there would strand them. */
  it("allows the send once the assignment has timed out", () => {
    const verdict = briefingReadyForHolding(
      briefingTimelineAt(state({ kind: "assigned" }), T0 + ASSIGNED_HOLD_MS + 1),
    );
    expect(verdict.ok).toBe(true);
  });

  it("falls back to the nominal length when the film's duration is unknown", () => {
    expect(at(T0 + NOMINAL_VIDEO_MS - 1, { videoDurationMs: null }).ok).toBe(false);
    expect(at(T0 + NOMINAL_VIDEO_MS, { videoDurationMs: null }).ok).toBe(true);
  });
});
