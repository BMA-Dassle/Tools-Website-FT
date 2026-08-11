import { describe, it, expect } from "vitest";
import { applyDemo, effectiveDemoMode, parseDemoMode } from "./demo";
import { fmtTime12, toEtWallClock } from "~/features/kiosk/checkin/itinerary";
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

  it("a VIP preview puts BOTH demo parties on the feed", () => {
    const decorated = applyDemo(baseFeed(now), "vip", now);
    expect(decorated?.vip?.length).toBe(2);
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
    // Marcus's bowling leg is 6 minutes out to Sarah's 8, so he leads — and
    // BOTH are on stage at once.
    expect(decision.vips?.map((v) => v.title)).toEqual(["Marcus", "Sarah"]);
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

  it("a PUSHED preview decorates the feed with no ?demo= in the URL — the broken case", () => {
    // THE 2026-08-11 BUG, pinned. The admin page pushed demoMode="vip" onto the
    // feed; the app resolved it correctly for the director but decorated the
    // feed with the raw URL mode ("off" on every wall), so the VIP entry was
    // never injected and every screen kept showing ads. This walks the exact
    // path a wall walks: pushed mode present, URL mode off.
    const feed = { ...baseFeed(now), demoMode: "vip" };
    const mode = effectiveDemoMode(feed, "off");
    expect(mode).toBe("vip");
    const decorated = applyDemo(feed, mode, now);
    expect(decorated?.vip?.length).toBe(2);
    expect(sceneHasData("vip-welcome", decorated)).toBe(true);
  });

  it("a pushed preview beats a ?demo= typed into the tab", () => {
    const feed = { ...baseFeed(now), demoMode: "event" };
    expect(effectiveDemoMode(feed, "vip")).toBe("event");
  });

  it("with nothing pushed, the URL mode stands", () => {
    expect(effectiveDemoMode(baseFeed(now), "race")).toBe("race");
    expect(effectiveDemoMode(null, "off")).toBe("off");
  });

  it("off leaves the feed untouched", () => {
    const feed = baseFeed(now);
    expect(applyDemo(feed, "off", now)).toBe(feed);
  });
});

describe("times on a wall (lesson 51a47370)", () => {
  it("renders a NAIVE ET start as written — the 7:00 AM bug", () => {
    // The availability cache stores "2026-08-11T11:00:00" with no zone. Parsing
    // that with new Date() on a UTC server and then converting to ET shifted it
    // back four hours, so an 11 AM opening advertised itself as "Next available
    // 7:00 AM" on the lobby wall.
    expect(fmtTime12(toEtWallClock("2026-08-11T11:00:00"))).toBe("11:00 AM");
    expect(fmtTime12(toEtWallClock("2026-08-11T15:30:00"))).toBe("3:30 PM");
  });

  it("also handles a Z-stamped time, so one helper is safe for both shapes", () => {
    // Neon TIMESTAMPTZ serializes with a Z; 15:00 UTC is 11:00 AM EDT.
    expect(fmtTime12(toEtWallClock("2026-08-11T15:00:00.000Z"))).toBe("11:00 AM");
  });

  it("is empty rather than wrong when there is no time", () => {
    expect(fmtTime12(toEtWallClock(""))).toBe("");
  });
});
