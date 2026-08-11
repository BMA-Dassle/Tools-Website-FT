import { describe, expect, it } from "vitest";
import { ROLE_PRESETS, resolveScreenConfig, rolePreset } from "../defaults";
import { resolveActiveScene } from "../director/schedule";
import { isSceneImplemented, sceneHasData } from "../scenes/registry";
import type { SignageEvent } from "../types";

/**
 * The briefing-room ROLE, end to end through the real scheduler.
 *
 * The property under test is operational, not cosmetic: a safety briefing must
 * own its wall for as long as it runs. Confetti over a safety film would be
 * absurd, and a rotation that cuts away mid-briefing means a room of people
 * missed part of it.
 */
const BRIEFING = resolveScreenConfig(rolePreset("briefing-room").config, "FT");

function celebration(atMs: number, over: Partial<SignageEvent> = {}): SignageEvent {
  return {
    id: `e-${atMs}`,
    kind: "booking-completed",
    center: "fort-myers",
    firstName: "Marcus",
    atMs,
    ...over,
  };
}

describe("the briefing-room role", () => {
  it("is offered at FastTrax only — the rooms exist nowhere else", () => {
    const preset = ROLE_PRESETS.find((p) => p.role === "briefing-room");
    expect(preset).toBeDefined();
    expect(preset!.venues).toEqual(["FT"]);
  });

  it("runs the briefing scene and nothing else", () => {
    expect(BRIEFING.playlist.map((p) => p.scene)).toEqual(["briefing"]);
  });

  it("is a scene this deploy can actually render", () => {
    // Omitting it from IMPLEMENTED is the exact bug that made billboard-crown
    // paint ads while the scheduler thought it was selected (2026-08-11).
    expect(isSceneImplemented("briefing")).toBe(true);
    expect(sceneHasData("briefing", null)).toBe(true);
  });

  it("selects the briefing scene at every point in the cycle", () => {
    for (const nowMs of [0, 1_000, 40_000, 137_000, 999_999, 1_760_000_000_000]) {
      const decision = resolveActiveScene({
        nowMs,
        config: BRIEFING,
        hasData: (s) => sceneHasData(s, null),
        events: [],
        seenEventIds: new Set(),
        isImplemented: isSceneImplemented,
      });
      expect(decision.scene).toBe("briefing");
      expect(decision.isInterrupt).toBe(false);
    }
  });

  it("NOTHING INTERRUPTS IT — not even a kiosk booking seconds ago", () => {
    const nowMs = 1_760_000_000_000;
    const decision = resolveActiveScene({
      nowMs,
      config: BRIEFING,
      hasData: (s) => sceneHasData(s, null),
      events: [celebration(nowMs - 2_000), celebration(nowMs - 500, { kind: "checkin-completed" })],
      seenEventIds: new Set(),
      isImplemented: isSceneImplemented,
    });
    expect(decision.scene).toBe("briefing");
  });

  it("not even a birthday check-in", () => {
    const nowMs = 1_760_000_000_000;
    const decision = resolveActiveScene({
      nowMs,
      config: BRIEFING,
      hasData: (s) => sceneHasData(s, null),
      events: [celebration(nowMs - 1_000, { kind: "checkin-completed", birthday: true })],
      seenEventIds: new Set(),
      isImplemented: isSceneImplemented,
    });
    expect(decision.scene).toBe("briefing");
  });

  it("still yields to SLEEP — a closed venue outranks everything", () => {
    const decision = resolveActiveScene({
      nowMs: 1_760_000_000_000,
      config: BRIEFING,
      hasData: (s) => sceneHasData(s, null),
      events: [],
      seenEventIds: new Set(),
      asleep: true,
      isImplemented: isSceneImplemented,
    });
    expect(decision.scene).toBe("sleep");
  });

  it("has every interrupt explicitly off, not merely defaulted", () => {
    expect(BRIEFING.celebration.enabled).toBe(false);
    expect(BRIEFING.vip.enabled).toBe(false);
    expect(BRIEFING.billboardCrown.enabled).toBe(false);
  });

  it("carries no room by default — there is no sensible side to guess", () => {
    expect(BRIEFING.briefingRoom).toBeNull();
  });

  it("resolves a stored room, and rejects anything that is not red or blue", () => {
    expect(resolveScreenConfig({ briefingRoom: "red" }, "FT").briefingRoom).toBe("red");
    expect(resolveScreenConfig({ briefingRoom: "blue" }, "FT").briefingRoom).toBe("blue");
    // A typo or a value from a newer deploy must not make a screen adopt a room.
    expect(
      resolveScreenConfig({ briefingRoom: "Red" as unknown as "red" }, "FT").briefingRoom,
    ).toBeNull();
  });
});

describe("rolePreset", () => {
  it("falls back to ads-only for a role this deploy does not have", () => {
    // Found by role rather than by index, so inserting a preset cannot silently
    // change what an unknown role falls back to.
    expect(rolePreset("nonsense" as never).role).toBe("ads-only");
  });

  it("returns each known role unchanged", () => {
    for (const preset of ROLE_PRESETS) {
      expect(rolePreset(preset.role).role).toBe(preset.role);
    }
  });
});
