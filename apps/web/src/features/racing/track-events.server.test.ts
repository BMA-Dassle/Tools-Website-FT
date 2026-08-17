import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE SUPPRESSION RULE, exercised end-to-end through the real handler with a
 * fake Redis — because the rule IS the Redis interplay and nothing pure can
 * prove it. The extractors and the wire timings they rest on are pinned
 * separately in track-events.test.ts.
 *
 * Deliberately not run against the live services: `.env.local` points at
 * production Neon, production Redis and the venue's real cameras, so a replay
 * there would write synthetic rows into a safety log, bookmark real footage,
 * and leave an emergency marker that would suppress a genuine desk pause.
 */

/** A Redis good enough for this module: string GET/SET/DEL with NX honoured. */
const store = new Map<string, string>();
const redisGet = vi.fn(async (k: string) => store.get(k) ?? null);
const redisDel = vi.fn(async (k: string) => {
  store.delete(k);
  return 1;
});
const redisSet = vi.fn(async (k: string, v: string, ...rest: unknown[]) => {
  if (rest.includes("NX") && store.has(k)) return null;
  store.set(k, v);
  return "OK";
});

const recordTrackEvent = vi.fn();
const bookmarkRaceEvent = vi.fn();
const raceBookmarksEnabled = vi.fn();

vi.mock("@/lib/redis", () => ({
  default: {
    get: (...a: unknown[]) => redisGet(...(a as [string])),
    set: (...a: unknown[]) => redisSet(...(a as [string, string])),
    del: (...a: unknown[]) => redisDel(...(a as [string])),
  },
}));
vi.mock("./data/track-events-db", () => ({
  recordTrackEvent: (...a: unknown[]) => recordTrackEvent(...a),
}));
vi.mock("~/features/signage/briefing/race-bookmarks.server", () => ({
  bookmarkRaceEvent: (...a: unknown[]) => bookmarkRaceEvent(...a),
}));
vi.mock("~/features/signage/briefing/race-bookmarks-setting.server", () => ({
  raceBookmarksEnabled: () => raceBookmarksEnabled(),
}));

import { handleTrackEvents } from "./track-events.server";

/* ── the real 2026-08-16 heat-60 records, verbatim ─────────────────────── */

const started = {
  $type: "SessionStartedNotification",
  ResourceId: 11208654,
  SessionId: 58599025,
  SessionName: "60 - Blue Starter",
  Date: "2026-08-16T23:10:00.716",
};
const deskPause = {
  $type: "SessionPausedNotification",
  ResourceId: 11208654,
  SessionId: 58599025,
  SessionName: "60 - Blue Starter",
  Date: "2026-08-16T23:13:36.13",
};
const deskResume = {
  $type: "SessionResumedNotification",
  ResourceId: 11208654,
  SessionId: 58599025,
  SessionName: "60 - Blue Starter",
  Date: "2026-08-16T23:14:45.055",
};
const emergencyOn = {
  $type: "EmergencyOnNotification",
  ResourceId: 11208654,
  Date: "2026-08-16T23:15:02.651",
};
const estopPause = {
  $type: "SessionPausedNotification",
  ResourceId: 11208654,
  SessionId: 58599025,
  SessionName: "60 - Blue Starter",
  Date: "2026-08-16T23:15:03.211",
};
const estopResume = {
  $type: "SessionResumedNotification",
  ResourceId: 11208654,
  SessionId: 58599025,
  SessionName: "60 - Blue Starter",
  Date: "2026-08-16T23:18:02.413",
};
const emergencyOff = {
  $type: "EmergencyOffNotification",
  ResourceId: 11208654,
  Date: "2026-08-16T23:18:07.866",
};
const finished = {
  $type: "SessionFinishedNotification",
  ResourceId: 11208654,
  SessionId: 58599025,
  SessionName: "60 - Blue Starter",
  Date: "2026-08-16T23:24:26.881",
};

const actions = () => recordTrackEvent.mock.calls.map((c) => (c[0] as { action: string }).action);
const rowFor = (action: string) =>
  recordTrackEvent.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .find((r) => r.action === action);

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  // clearAllMocks resets CALLS, not implementations — so a test that makes
  // Redis reject would otherwise leak into every test after it. Re-install the
  // working fakes explicitly.
  redisGet.mockImplementation(async (k: string) => store.get(k) ?? null);
  redisDel.mockImplementation(async (k: string) => {
    store.delete(k);
    return 1;
  });
  redisSet.mockImplementation(async (k: string, v: string, ...rest: unknown[]) => {
    if (rest.includes("NX") && store.has(k)) return null;
    store.set(k, v);
    return "OK";
  });
  raceBookmarksEnabled.mockResolvedValue(true);
  bookmarkRaceEvent.mockResolvedValue(15);
  recordTrackEvent.mockResolvedValue(undefined);
});

describe("handleTrackEvents — the E-stop suppression rule", () => {
  it("logs a DESK pause and resume, which had no emergency", async () => {
    await handleTrackEvents([started]);
    await handleTrackEvents([deskPause]);
    await handleTrackEvents([deskResume]);
    expect(actions()).toEqual(["session-start", "paused", "resumed"]);
  });

  it("does NOT log the pause an E-stop causes — one incident, one row", async () => {
    await handleTrackEvents([started]);
    await handleTrackEvents([emergencyOn]);
    await handleTrackEvents([estopPause]);
    await handleTrackEvents([estopResume]);
    expect(actions()).toEqual(["session-start", "emergency-on"]);
  });

  it("marks the cameras once for that incident, not twice", async () => {
    await handleTrackEvents([started]);
    await handleTrackEvents([emergencyOn]);
    await handleTrackEvents([estopPause]);
    const phases = bookmarkRaceEvent.mock.calls.map((c) => (c[0] as { phase: string }).phase);
    expect(phases).toEqual(["emergency-on"]);
  });

  it("resumes logging desk pauses once the all-clear lands", async () => {
    await handleTrackEvents([started, emergencyOn, estopPause, estopResume, emergencyOff]);
    recordTrackEvent.mockClear();
    await handleTrackEvents([deskPause]);
    expect(actions()).toEqual(["paused"]);
  });

  it("still logs a start or finish that happens under an emergency", async () => {
    // Only the interruption pair is the E-stop's own; a session genuinely
    // ending mid-incident is a separate fact and must not vanish.
    await handleTrackEvents([started, emergencyOn, finished]);
    expect(actions()).toEqual(["session-start", "emergency-on", "session-end"]);
  });
});

describe("handleTrackEvents — session correlation", () => {
  it("infers the heat for an emergency and never claims the wire said it", async () => {
    await handleTrackEvents([started]);
    await handleTrackEvents([emergencyOn]);
    const row = rowFor("emergency-on")!;
    expect(row.sessionId).toBeNull();
    expect(row.inferredSessionId).toBe("58599025");
    expect(row.heatNumber).toBe(60);
    expect(row.heatName).toBe("60 - Blue Starter");
  });

  it("puts the wire's own session id on a lifecycle row", async () => {
    await handleTrackEvents([started]);
    const row = rowFor("session-start")!;
    expect(row.sessionId).toBe("58599025");
    expect(row.inferredSessionId ?? null).toBeNull();
  });

  it("attributes an emergency between heats to NO session", async () => {
    await handleTrackEvents([started, finished]);
    await handleTrackEvents([emergencyOn]);
    expect(rowFor("emergency-on")!.inferredSessionId).toBeNull();
  });
});

describe("handleTrackEvents — replays and repeats", () => {
  it("writes a re-delivered event only once", async () => {
    await handleTrackEvents([started]);
    await handleTrackEvents([started]);
    await handleTrackEvents([finished]);
    // SessionFinished really was delivered twice on the night (23:24:26.881
    // and again at 23:25:24.162 with a different Id).
    await handleTrackEvents([finished]);
    expect(actions()).toEqual(["session-start", "session-end"]);
  });

  it("keeps two E-stops in the same minute as two incidents", async () => {
    const on2 = { ...emergencyOn, Date: "2026-08-16T23:18:08.809" };
    const on3 = { ...emergencyOn, Date: "2026-08-16T23:18:20.574" };
    await handleTrackEvents([started]);
    await handleTrackEvents([on2]);
    await handleTrackEvents([{ ...emergencyOff, Date: "2026-08-16T23:18:12.61" }]);
    await handleTrackEvents([on3]);
    expect(actions()).toEqual(["session-start", "emergency-on", "emergency-off", "emergency-on"]);
  });

  it("re-raises the marker on a replayed E-stop so its pause stays suppressed", async () => {
    // The claim stops the second row, but the marker must still be up or the
    // replayed pause would slip through as a phantom desk pause.
    await handleTrackEvents([started, emergencyOn]);
    recordTrackEvent.mockClear();
    await handleTrackEvents([emergencyOn, estopPause]);
    expect(actions()).toEqual([]);
  });
});

describe("handleTrackEvents — it never throws into the webhook", () => {
  it("survives a Redis that is refusing everything", async () => {
    redisGet.mockRejectedValue(new Error("redis down"));
    redisSet.mockRejectedValue(new Error("redis down"));
    await expect(handleTrackEvents([started, emergencyOn, deskPause])).resolves.toBeUndefined();
  });

  it("survives a camera system that is down", async () => {
    bookmarkRaceEvent.mockRejectedValue(new Error("nvr down"));
    await handleTrackEvents([started, deskPause]);
    // The log still lands — footage annotation failing must not lose the record.
    expect(actions()).toContain("paused");
  });

  it("ignores records with no track or no stamp", async () => {
    await handleTrackEvents([
      { $type: "EmergencyOnNotification", ResourceId: 99999, Date: "2026-08-16T23:15:02.651" },
      { $type: "SessionPausedNotification", ResourceId: 11208654, SessionId: 1, Date: "junk" },
    ]);
    expect(recordTrackEvent).not.toHaveBeenCalled();
  });
});
