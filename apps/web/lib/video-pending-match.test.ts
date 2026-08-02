import { describe, it, expect, afterEach, vi } from "vitest";
import {
  mergeBufferedEvent,
  planDrainOrder,
  pendingCameraKey,
  settleMs,
  orderedMatchingEnabled,
  type DrainPlanEntry,
} from "@/lib/video-pending-match";
import type { VideoEventInput } from "@/lib/video-event-processor";
import {
  isJunkDuration,
  shouldDisplaceJunk,
  junkMinDurationS,
  junkQuarantineEnabled,
} from "@/lib/video-match";

afterEach(() => {
  vi.unstubAllEnvs();
});

const ev = (over: Partial<VideoEventInput>): VideoEventInput => ({
  id: 1,
  code: "AAAAAAAAAA",
  ...over,
});

describe("junk classification (isJunkDuration / shouldDisplaceJunk)", () => {
  it("treats sub-floor durations as junk — the corpus showed <120s was 100% junk", () => {
    expect(isJunkDuration(0)).toBe(true);
    expect(isJunkDuration(1)).toBe(true); // the Jessica May 1s clip
    expect(isJunkDuration(44)).toBe(true);
    expect(isJunkDuration(119)).toBe(true);
  });

  it("keeps crash-shortened real races — shortest real crash video was 133s", () => {
    expect(isJunkDuration(120)).toBe(false);
    expect(isJunkDuration(133)).toBe(false);
    expect(isJunkDuration(340)).toBe(false); // Riley Townsend's crash heat
    expect(isJunkDuration(869)).toBe(false);
  });

  it("never junks unknown durations — can't judge what we can't measure", () => {
    expect(isJunkDuration(undefined)).toBe(false);
    expect(isJunkDuration(null)).toBe(false);
    expect(isJunkDuration(NaN)).toBe(false);
  });

  it("kill switch VIDEO_JUNK_QUARANTINE=false disables everything", () => {
    vi.stubEnv("VIDEO_JUNK_QUARANTINE", "false");
    expect(junkQuarantineEnabled()).toBe(false);
    expect(isJunkDuration(1)).toBe(false);
    expect(shouldDisplaceJunk(1, 900)).toBe(false);
  });

  it("VIDEO_JUNK_MIN_S tunes the floor; garbage values fall back to 120", () => {
    vi.stubEnv("VIDEO_JUNK_MIN_S", "60");
    expect(junkMinDurationS()).toBe(60);
    expect(isJunkDuration(59)).toBe(true);
    expect(isJunkDuration(61)).toBe(false);
    vi.stubEnv("VIDEO_JUNK_MIN_S", "banana");
    expect(junkMinDurationS()).toBe(120);
    vi.stubEnv("VIDEO_JUNK_MIN_S", "-5");
    expect(junkMinDurationS()).toBe(120);
  });

  it("displaces only KNOWN-real over KNOWN-junk", () => {
    expect(shouldDisplaceJunk(1, 900)).toBe(true); // junk out, real in
    expect(shouldDisplaceJunk(900, 1)).toBe(false); // never displace a real video
    expect(shouldDisplaceJunk(1, undefined)).toBe(false); // unknown incoming can't displace
    expect(shouldDisplaceJunk(undefined, 900)).toBe(false); // unknown occupant isn't junk
    expect(shouldDisplaceJunk(1, 119)).toBe(false); // junk can't displace junk
  });
});

describe("mergeBufferedEvent", () => {
  it("keeps the earliest created_at and the latest lifecycle fields", () => {
    const first = ev({
      created_at: "2026-08-02T19:35:54.000Z",
      status: "TRANSFERRED",
      duration: undefined,
    });
    const second = ev({
      created_at: "2026-08-02T19:36:10.000Z", // VT3 disagreeing with itself — earliest wins
      status: "PENDING_ACTIVATION",
      sampleUploadTime: "2026-08-02T19:39:36.000Z",
      duration: 869,
    });
    const merged = mergeBufferedEvent(first, second);
    expect(merged.created_at).toBe("2026-08-02T19:35:54.000Z");
    expect(merged.status).toBe("PENDING_ACTIVATION");
    expect(merged.sampleUploadTime).toBe("2026-08-02T19:39:36.000Z");
    expect(merged.duration).toBe(869);
  });

  it("a later field-less event never clears earlier data", () => {
    const first = ev({
      created_at: "2026-08-02T19:35:54.000Z",
      status: "UPLOADED",
      duration: 869,
      camera: 73,
    });
    const sampleOnly = ev({ forceReady: true, status: null, camera: null });
    const merged = mergeBufferedEvent(first, sampleOnly);
    expect(merged.created_at).toBe("2026-08-02T19:35:54.000Z");
    expect(merged.status).toBe("UPLOADED");
    expect(merged.duration).toBe(869);
    expect(merged.camera).toBe(73);
    expect(merged.forceReady).toBe(true);
  });

  it("forceReady is sticky once a sample-uploaded event set it", () => {
    const sampleFirst = ev({ forceReady: true });
    const updateLater = ev({ created_at: "2026-08-02T19:35:54.000Z", status: "TRANSFERRED" });
    expect(mergeBufferedEvent(sampleFirst, updateLater).forceReady).toBe(true);
    expect(mergeBufferedEvent(updateLater, sampleFirst).forceReady).toBe(true);
  });

  it("no previous event → returns the incoming one", () => {
    const only = ev({ created_at: "2026-08-02T19:35:54.000Z" });
    expect(mergeBufferedEvent(undefined, only)).toBe(only);
  });
});

describe("pendingCameraKey", () => {
  it("camera hardware id first, station name as fallback — mirrors the matcher", () => {
    expect(pendingCameraKey(ev({ camera: 73, system: { name: "913" } }))).toBe("73");
    expect(pendingCameraKey(ev({ camera: null, system: { name: "913" } }))).toBe("913");
    expect(pendingCameraKey(ev({ camera: null }))).toBe("");
  });
});

describe("planDrainOrder — the arrival-order fix", () => {
  const entry = (o: Partial<DrainPlanEntry>): DrainPlanEntry => ({
    code: "X",
    cameraKey: "40",
    orderMs: 0,
    id: 0,
    firstReceivedAtMs: 0,
    ...o,
  });
  const NOW = 1_000_000;
  const SETTLE = 90_000;

  it("reorders out-of-order arrivals on one camera by created_at", () => {
    // B captured later but ARRIVED first (smaller encode). Both settled.
    const entries = [
      entry({ code: "B-LATER", orderMs: 200, id: 2, firstReceivedAtMs: NOW - 500_000 }),
      entry({ code: "A-EARLIER", orderMs: 100, id: 1, firstReceivedAtMs: NOW - 400_000 }),
    ];
    expect(planDrainOrder(entries, NOW, SETTLE)).toEqual(["A-EARLIER", "B-LATER"]);
  });

  it("a later video on the same camera WAITS behind an earlier one still settling", () => {
    const entries = [
      // earlier capture, arrived 10s ago — not settled yet
      entry({ code: "A-EARLIER", orderMs: 100, id: 1, firstReceivedAtMs: NOW - 10_000 }),
      // later capture, arrived long ago — settled
      entry({ code: "B-LATER", orderMs: 200, id: 2, firstReceivedAtMs: NOW - 500_000 }),
    ];
    // B must NOT jump A — processing B first would hand it A's slot.
    expect(planDrainOrder(entries, NOW, SETTLE)).toEqual([]);
  });

  it("different cameras are independent — one camera's settling video holds nothing else", () => {
    const entries = [
      entry({ code: "CAM40-SETTLING", cameraKey: "40", orderMs: 100, firstReceivedAtMs: NOW - 1_000 }),
      entry({ code: "CAM41-READY", cameraKey: "41", orderMs: 200, firstReceivedAtMs: NOW - 500_000 }),
    ];
    expect(planDrainOrder(entries, NOW, SETTLE)).toEqual(["CAM41-READY"]);
  });

  it("same created_at (batch dock) breaks ties by VT3 id — on-camera file order", () => {
    const entries = [
      entry({ code: "SECOND-FILE", orderMs: 100, id: 20, firstReceivedAtMs: NOW - 500_000 }),
      entry({ code: "FIRST-FILE", orderMs: 100, id: 10, firstReceivedAtMs: NOW - 500_000 }),
    ];
    expect(planDrainOrder(entries, NOW, SETTLE)).toEqual(["FIRST-FILE", "SECOND-FILE"]);
  });

  it("settled prefix processes even when the camera's tail is still settling", () => {
    const entries = [
      entry({ code: "A", orderMs: 100, id: 1, firstReceivedAtMs: NOW - 500_000 }),
      entry({ code: "B", orderMs: 200, id: 2, firstReceivedAtMs: NOW - 400_000 }),
      entry({ code: "C", orderMs: 300, id: 3, firstReceivedAtMs: NOW - 1_000 }), // fresh
    ];
    expect(planDrainOrder(entries, NOW, SETTLE)).toEqual(["A", "B"]);
  });

  it("cameras emit earliest-first for determinism", () => {
    const entries = [
      entry({ code: "LATE-CAM", cameraKey: "9", orderMs: 500, firstReceivedAtMs: NOW - 500_000 }),
      entry({ code: "EARLY-CAM", cameraKey: "7", orderMs: 50, firstReceivedAtMs: NOW - 500_000 }),
    ];
    expect(planDrainOrder(entries, NOW, SETTLE)).toEqual(["EARLY-CAM", "LATE-CAM"]);
  });
});

describe("env-tuned knobs", () => {
  it("settle window defaults to 90s and is tunable", () => {
    expect(settleMs()).toBe(90_000);
    vi.stubEnv("VIDEO_MATCH_SETTLE_S", "30");
    expect(settleMs()).toBe(30_000);
    vi.stubEnv("VIDEO_MATCH_SETTLE_S", "junk");
    expect(settleMs()).toBe(90_000);
  });

  it("ordered matching defaults ON; only the literal 'false' kills it", () => {
    expect(orderedMatchingEnabled()).toBe(true);
    vi.stubEnv("VIDEO_MATCH_ORDERED", "false");
    expect(orderedMatchingEnabled()).toBe(false);
    vi.stubEnv("VIDEO_MATCH_ORDERED", "0");
    expect(orderedMatchingEnabled()).toBe(true); // kill switch is exactly "false"
  });
});
