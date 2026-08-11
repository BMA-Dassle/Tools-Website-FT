import { describe, expect, it } from "vitest";
import { briefingStateTtlSeconds, briefingTimelineAt } from "./phase";
import { HELMET_PHASE_MS, NOMINAL_VIDEO_MS, QUALS_PHASE_MS, type BriefingRoomState } from "./types";

const VIDEO_MS = 4 * 60_000; // a four-minute briefing film
const T0 = 1_760_000_000_000;

function state(over: Partial<BriefingRoomState> = {}): BriefingRoomState {
  return {
    kind: "timeline",
    tier: "starter",
    track: "red",
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
    expect(briefingTimelineAt(state(), T0 + VIDEO_MS + HELMET_PHASE_MS).phase).toBe("quals");
  });

  it("holds the qualification board, then falls idle", () => {
    const qualsStart = T0 + VIDEO_MS + HELMET_PHASE_MS;
    expect(briefingTimelineAt(state(), qualsStart + 60_000).phase).toBe("quals");
    expect(briefingTimelineAt(state(), qualsStart + QUALS_PHASE_MS - 1).phase).toBe("quals");
    expect(briefingTimelineAt(state(), qualsStart + QUALS_PHASE_MS).phase).toBe("idle");
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
    expect(briefingTimelineAt(noVideo, T0 + HELMET_PHASE_MS).phase).toBe("quals");
  });

  it("falls back to a nominal length when duration is unknown", () => {
    const unknown = state({ videoDurationMs: null });
    expect(briefingTimelineAt(unknown, T0 + NOMINAL_VIDEO_MS - 1).phase).toBe("video");
    expect(briefingTimelineAt(unknown, T0 + NOMINAL_VIDEO_MS).phase).toBe("helmet");
  });

  it("quals-only jumps straight to the board and never plays a film", () => {
    const q = state({ kind: "quals-only", tier: null, videoUrl: null });
    expect(briefingTimelineAt(q, T0).phase).toBe("quals");
    expect(briefingTimelineAt(q, T0 + QUALS_PHASE_MS - 1).phase).toBe("quals");
    expect(briefingTimelineAt(q, T0 + QUALS_PHASE_MS).phase).toBe("idle");
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

describe("briefingStateTtlSeconds", () => {
  it("outlives the whole timeline", () => {
    const ttlMs = briefingStateTtlSeconds(state()) * 1000;
    expect(ttlMs).toBeGreaterThan(VIDEO_MS + HELMET_PHASE_MS + QUALS_PHASE_MS);
  });

  it("scales with a longer film", () => {
    const short = briefingStateTtlSeconds(state({ videoDurationMs: 60_000 }));
    const long = briefingStateTtlSeconds(state({ videoDurationMs: 20 * 60_000 }));
    expect(long).toBeGreaterThan(short);
  });

  it("covers the quals hold for a quals-only send", () => {
    const ttl = briefingStateTtlSeconds(state({ kind: "quals-only" }));
    expect(ttl).toBe(Math.ceil(QUALS_PHASE_MS / 1000));
  });
});
