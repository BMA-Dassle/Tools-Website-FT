import { describe, it, expect } from "vitest";
import {
  applyDemo,
  demoBriefingRooms,
  demoIsMegaDay,
  effectiveDemoMode,
  parseDemoMode,
} from "./demo";
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
    briefing: null,
    briefingRooms: null,
    roomBlocked: null,
    pitBoard: null,
    pitLanes: null,
    pitRosters: null,
    checkinProgress: null,
    checkinReturning: null,
    raceResults: null,
    topTimes: null,
    raceGuide: null,
    bowlingTonight: null,
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

  it("a VIP preview reaches a LOBBY board as welcome-board content", () => {
    // VIP is no longer an interrupt (owner: "it shouldn't just take over
    // everything") — it is the gold slide inside the welcome rotation, so a
    // pushed VIP preview must earn the event-welcome segment its slot even
    // with no parties booked today.
    const lobby = resolveScreenConfig(
      { playlist: [{ scene: "event-welcome", slots: 2, requiresData: true }] },
      "HPFM",
    );
    const decorated = applyDemo(baseFeed(now), "vip", now);
    expect(decorated?.vip?.length).toBe(2);
    expect(sceneHasData("event-welcome", decorated)).toBe(true);
    const decision = resolveActiveScene({
      nowMs: now,
      config: lobby,
      hasData: (scene) => sceneHasData(scene, decorated),
      events: decorated?.kioskEvents ?? [],
      seenEventIds: new Set(),
    });
    expect(decision.scene).toBe("event-welcome");
  });

  it("a preview clears live events — press the button, see that scene", () => {
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
      events: decorated?.kioskEvents ?? [],
      seenEventIds: new Set(),
    });
    expect(decision.scene).not.toBe("celebration");
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

describe("Mega previews", () => {
  it("knows a Mega day in ET, not the browser's zone", () => {
    // Tuesday 2026-08-11: 03:00Z is still Monday evening in ET; 17:00Z is
    // Tuesday afternoon. The venue's day is the only one that matters.
    expect(demoIsMegaDay(Date.parse("2026-08-11T03:00:00Z"))).toBe(false);
    expect(demoIsMegaDay(Date.parse("2026-08-11T17:00:00Z"))).toBe(true);
    expect(demoIsMegaDay(Date.parse("2026-08-12T17:00:00Z"))).toBe(false);
  });

  it("a race preview KEEPS real events — Simulate scan must land during a preview", () => {
    // The event/vip previews clear live events for determinism; the race
    // preview must not, because it is exactly when staff press Simulate scan
    // and watch for the name (owner: "simulate scan button not working").
    const now = Date.parse("2026-08-11T17:00:00Z");
    const feed = baseFeed(now);
    feed.kioskEvents = [
      {
        id: "real-1",
        kind: "racer-scanned",
        center: "fort-myers",
        firstName: "Jayden",
        atMs: now - 1_000,
      },
    ];
    const decorated = applyDemo(feed, "race", now);
    expect(decorated?.kioskEvents.some((e) => e.id === "real-1")).toBe(true);
    expect(decorated?.kioskEvents.length).toBe(7); // 1 real + 6 fixtures
  });

  it("a race preview carries a burst of scans, scoped to the screen's track", () => {
    // The rail and the Mega check-in feed need names to show; deterministic so
    // both boards of a pair fabricate identical fields.
    const feed = baseFeed(Date.parse("2026-08-11T17:00:00Z"));
    feed.screen = {
      ...feed.screen!,
      config: { scope: { resourceIds: ["11208654"] } },
    };
    const decorated = applyDemo(feed, "race", feed.now);
    expect(decorated?.kioskEvents.length).toBe(6);
    expect(decorated?.kioskEvents.every((e) => e.resourceId === "11208654")).toBe(true);
    expect(decorated?.kioskEvents[0].firstName).toBe("Marcus");
  });
});

describe("demoBriefingRooms — the anchor is stable across ticks", () => {
  it("returns the SAME triggeredAtMs while the clock advances", () => {
    // THE BUG: `triggeredAtMs: nowMs - 1_000`, rebuilt on every render. The scene
    // keys the <video> on triggeredAtMs and the director ticks nowMs 4×/second, so
    // in PREVIEW mode the element was destroyed and recreated four times a second —
    // it could never decode a frame. Every admin-preview test of the briefing rooms
    // failed on this while real sends (stamp stored once in Redis) worked
    // (owner 2026-08-11, "this is deploy like 8 now").
    const t0 = 1_760_000_000_000;
    const feed = null; // no manifest — nominal durations apply
    const first = demoBriefingRooms(t0, feed, "briefing").red!.triggeredAtMs;
    for (const tick of [250, 500, 750, 1_000, 30_000, 120_000]) {
      expect(demoBriefingRooms(t0 + tick, feed, "briefing").red!.triggeredAtMs).toBe(first);
    }
  });

  it("re-arms once the preview's own timeline has fully run out", () => {
    const t0 = 1_760_100_000_000;
    const first = demoBriefingRooms(t0, null, "briefing").red!.triggeredAtMs;
    // Past film (nominal 5:00) + helmet + the idle minute → a fresh pass begins.
    const later = t0 + 8 * 60_000;
    const second = demoBriefingRooms(later, null, "briefing").red!.triggeredAtMs;
    expect(second).not.toBe(first);
    expect(second).toBeGreaterThan(first);
  });

  it("switching preview modes re-anchors immediately", () => {
    const t0 = 1_760_200_000_000;
    const film = demoBriefingRooms(t0, null, "briefing").red!.triggeredAtMs;
    const quals = demoBriefingRooms(t0 + 250, null, "briefing-return").red!.triggeredAtMs;
    expect(quals).not.toBe(film);
  });
});
