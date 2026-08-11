import { describe, it, expect } from "vitest";
import { applyDemo, parseDemoMode } from "./demo";
import { resolveScreenConfig } from "./defaults";
import { resolveActiveScene } from "./director/schedule";
import { sceneHasData } from "./scenes/registry";
import type { TvFeed } from "./types";

/** A feed shaped like the one a real track screen receives. */
function baseFeed(now: number): TvFeed {
  return {
    now,
    screen: {
      screenId: "FT:1",
      venue: "FT",
      center: "fort-myers",
      screenNumber: 1,
      name: "Blue Track check-in",
      config: {},
      updatedAt: "",
    },
    events: null,
    vip: null,
    kioskEvents: [],
    raceCheckin: null,
    pausedProductIds: [],
    nextAvailable: null,
    reloadAt: null,
    demoMode: null,
    degraded: false,
  };
}

/** FT:1 as actually provisioned in production. */
const TRACK_CONFIG = resolveScreenConfig(
  {
    playlist: [{ scene: "race-checkin", slots: 3 }],
    interrupts: { celebration: { enabled: true }, "billboard-crown": { enabled: false } },
    scope: { resourceIds: ["11208654"] },
    pairing: { groupId: "ft-tracks", position: 0, count: 2 },
  },
  "FT",
);

describe("pushed previews", () => {
  const now = Date.parse("2026-08-11T20:00:00.000Z");

  it("parses the modes the admin page can push", () => {
    expect(parseDemoMode("vip")).toBe("vip");
    expect(parseDemoMode("race")).toBe("race");
    expect(parseDemoMode("event")).toBe("event");
    expect(parseDemoMode(null)).toBe("off");
    expect(parseDemoMode("nonsense")).toBe("off");
  });

  it("a VIP preview puts a party on the feed", () => {
    const decorated = applyDemo(baseFeed(now), "vip", now);
    expect(decorated?.vip?.length).toBe(1);
    expect(sceneHasData("vip-welcome", decorated)).toBe(true);
  });

  it("a VIP preview actually reaches the screen on a track board", () => {
    // The end-to-end assertion: admin pushes "vip", and the director decides to
    // render the VIP takeover on a board whose playlist is race-checkin only.
    const decorated = applyDemo(baseFeed(now), "vip", now);
    const decision = resolveActiveScene({
      nowMs: now,
      config: TRACK_CONFIG,
      hasData: (scene) => sceneHasData(scene, decorated),
      vips: decorated?.vip ?? null,
      events: decorated?.kioskEvents ?? [],
      seenEventIds: new Set(),
    });
    expect(decision.scene).toBe("vip-welcome");
    expect(decision.vip?.title).toBe("Sarah");
  });

  it("a preview WINS over a live birthday — press the button, see that scene", () => {
    // The bug behind "preview VIP is not working": a birthday fired in the last
    // ninety seconds outranks the rotation, so the preview appeared to do
    // nothing. Correct precedence for a guest moment, useless for a staff tool.
    const feed = baseFeed(now);
    feed.kioskEvents = [
      { id: "b1", kind: "racer-scanned", center: "fort-myers", birthday: true, atMs: now - 5_000 },
    ];
    const decorated = applyDemo(feed, "vip", now);
    expect(decorated?.kioskEvents).toEqual([]);

    const decision = resolveActiveScene({
      nowMs: now,
      config: TRACK_CONFIG,
      hasData: (scene) => sceneHasData(scene, decorated),
      vips: decorated?.vip ?? null,
      events: decorated?.kioskEvents ?? [],
      seenEventIds: new Set(),
    });
    expect(decision.scene).toBe("vip-welcome");
  });

  it("an event preview puts parties on the board", () => {
    const decorated = applyDemo(baseFeed(now), "event", now);
    expect((decorated?.events?.length ?? 0) > 0).toBe(true);
    expect(sceneHasData("event-welcome", decorated)).toBe(true);
  });

  it("off leaves the feed untouched", () => {
    const feed = baseFeed(now);
    expect(applyDemo(feed, "off", now)).toBe(feed);
  });
});
