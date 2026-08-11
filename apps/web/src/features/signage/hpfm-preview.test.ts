import { describe, it, expect } from "vitest";
import { applyDemo } from "./demo";
import { resolveScreenConfig } from "./defaults";
import { resolveActiveScene, SLOT_MS, CROWN_WINDOW_MS } from "./director/schedule";
import { sceneHasData, isSceneImplemented } from "./scenes/registry";
import type { TvFeed } from "./types";

/**
 * HPFM:1 exactly as provisioned in production, copied from the live feed.
 *
 * The owner reported Preview welcome and Preview VIP "still not working" on the
 * HeadPinz screen after both were confirmed reaching it. Reproducing against
 * the real config rather than a tidy fixture is the only way to see why.
 */
const HPFM_CONFIG = resolveScreenConfig(
  {
    scope: {},
    playlist: [
      { scene: "event-welcome", slots: 2, requiresData: true },
      { scene: "ads", slots: 1 },
    ],
    interrupts: {
      celebration: { enabled: true },
      "vip-welcome": { enabled: true, leadMins: 10 },
      "billboard-crown": { enabled: true },
    },
    showNextAvailable: true,
  },
  "HPFM",
);

function feedAt(now: number): TvFeed {
  return {
    now,
    screen: null,
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

function decide(now: number, mode: "vip" | "event") {
  const decorated = applyDemo(feedAt(now), mode, now);
  return resolveActiveScene({
    nowMs: now,
    config: HPFM_CONFIG,
    hasData: (scene) => sceneHasData(scene, decorated),
    events: decorated?.kioskEvents ?? [],
    seenEventIds: new Set(),
    isImplemented: isSceneImplemented,
  });
}

describe("HPFM:1 previews, against the real production config", () => {
  // A moment inside the billboard-crown window at the top of a 40s cycle.
  const inCrownWindow = 10 * SLOT_MS + 2_000;
  // A moment well clear of it.
  const clearOfCrown = 10 * SLOT_MS + CROWN_WINDOW_MS + 5_000;

  it("a VIP preview shows as welcome-board content (VIP is not an interrupt)", () => {
    expect(decide(clearOfCrown, "vip").scene).toBe("event-welcome");
  });

  it("welcome preview shows outside the crown window", () => {
    expect(decide(clearOfCrown, "event").scene).toBe("event-welcome");
  });

  it("the crown can no longer steal the screen, because it is not built", () => {
    // THE BUG. billboard-crown was enabled on this screen, so it preempted the
    // rotation for ~12s of every 40s — and the registry has no case for it, so
    // it painted as house ads. On the floor: press Preview welcome, look up
    // during that window, see ads, conclude the preview did nothing.
    //
    // The scheduler now refuses to select a scene this deploy cannot render.
    expect(isSceneImplemented("billboard-crown")).toBe(false);
    expect(decide(inCrownWindow, "event").scene).toBe("event-welcome");
  });

  it("the welcome board gets two slots in three — never two ads back to back", () => {
    // What the screen ACTUALLY does across a full cycle, now that nothing
    // unbuilt can steal a turn: 80 seconds of welcome, then 40 of ads. The
    // party board is on screen two thirds of the time and an advert can never
    // follow an advert.
    const scenes = [0, 1, 2].map((slot) => decide((10 + slot) * SLOT_MS + 5_000, "event").scene);
    expect(scenes.filter((x) => x === "event-welcome")).toHaveLength(2);
    expect(scenes.filter((x) => x === "ads")).toHaveLength(1);
    // Whatever the phase, an advert is never followed by another advert.
    expect(scenes.join(">")).not.toContain("ads>ads");
  });

  it("a VIP preview also survives the crown window — the crown is unbuilt", () => {
    expect(decide(inCrownWindow, "vip").scene).toBe("event-welcome");
  });
});
