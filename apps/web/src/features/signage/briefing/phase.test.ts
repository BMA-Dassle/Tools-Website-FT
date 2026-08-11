import { describe, expect, it } from "vitest";
import { briefingStateTtlSeconds, briefingTimelineAt } from "./phase";
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

  it("shows helmet sizes for 30 seconds after the film", () => {
    expect(briefingTimelineAt(state(), T0 + VIDEO_MS).phase).toBe("helmet");
    expect(briefingTimelineAt(state(), T0 + VIDEO_MS + 29_000).phase).toBe("helmet");
    expect(briefingTimelineAt(state(), T0 + VIDEO_MS + HELMET_PHASE_MS).phase).toBe("idle");
  });

  it("FREES THE ROOM the moment helmets are done — there is no third phase", () => {
    // Owner 2026-08-11: "once the helmet portion is done this should clear and be
    // ready for the next". A 30-minute third phase left an emptied room reading as
    // busy on the control board.
    const helmetEnd = T0 + VIDEO_MS + HELMET_PHASE_MS;
    expect(briefingTimelineAt(state(), helmetEnd - 1).phase).toBe("helmet");
    expect(briefingTimelineAt(state(), helmetEnd).phase).toBe("idle");
    expect(briefingTimelineAt(state(), helmetEnd + 60_000).phase).toBe("idle");
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
    // Straight to helmet sizes rather than a black screen for five minutes.
    expect(briefingTimelineAt(noVideo, T0).phase).toBe("helmet");
    expect(briefingTimelineAt(noVideo, T0 + HELMET_PHASE_MS).phase).toBe("idle");
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
