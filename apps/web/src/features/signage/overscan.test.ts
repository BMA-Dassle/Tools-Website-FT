import { describe, expect, it } from "vitest";
import { clampOverscanPct, TV_H, TV_MAX_OVERSCAN_PCT, TV_W, tvFitScale } from "./constants";
import { resolveScreenConfig, ROLE_PRESETS, rolePreset } from "./defaults";
import type { ScreenConfig } from "./types";

/**
 * PER-PANEL OVERSCAN CORRECTION.
 *
 * Some TVs crop ~2–5% off the edge of their own input, so a canvas authored to
 * fill 1920×1080 loses its bottom line behind the bezel. `overscanPct` insets
 * the picture inside the same letterbox so the panel's crop eats black.
 *
 * WHAT THESE TESTS ARE REALLY DEFENDING: this one number scales an entire wall.
 * The failure mode is not a mis-fitted screen, it is a DARK one — a 100 typed
 * into the admin form, or a stale/foreign config, must not be able to reach a
 * transform of scale(0) in a lobby. So the two properties asserted hardest are
 * (a) every screen that has never been told about this is byte-identical to
 * before, and (b) no input of any kind produces a scale of 0 or a negative one.
 */

const VIEWPORT = { w: 1920, h: 1080 };

describe("clampOverscanPct", () => {
  it("treats an absent or non-numeric value as a panel that is fine", () => {
    expect(clampOverscanPct(undefined)).toBe(0);
    expect(clampOverscanPct(null)).toBe(0);
    expect(clampOverscanPct("3")).toBe(0);
    expect(clampOverscanPct(Number.NaN)).toBe(0);
    expect(clampOverscanPct(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("passes a sane correction through untouched", () => {
    expect(clampOverscanPct(0)).toBe(0);
    expect(clampOverscanPct(2.5)).toBe(2.5);
    expect(clampOverscanPct(TV_MAX_OVERSCAN_PCT)).toBe(TV_MAX_OVERSCAN_PCT);
  });

  it("clamps the fat-fingered 100 that would otherwise unlight a wall", () => {
    expect(clampOverscanPct(100)).toBe(TV_MAX_OVERSCAN_PCT);
    expect(clampOverscanPct(50)).toBe(TV_MAX_OVERSCAN_PCT);
  });

  it("clamps a negative, which would blow the canvas up past the panel", () => {
    expect(clampOverscanPct(-3)).toBe(0);
    expect(clampOverscanPct(-1000)).toBe(0);
  });
});

describe("tvFitScale", () => {
  it("is unchanged from the pre-overscan behaviour when nothing is set", () => {
    // The regression that matters: every TV already hanging must fit exactly as
    // it did before this field existed.
    for (const [w, h] of [
      [1920, 1080],
      [3840, 2160],
      [1366, 768],
      [1280, 1024],
    ]) {
      expect(tvFitScale(w, h)).toBe(Math.min(h / TV_H, w / TV_W));
      expect(tvFitScale(w, h, 0)).toBe(Math.min(h / TV_H, w / TV_W));
    }
  });

  it("insets by the percentage on EVERY edge, so 3% costs 6% of the width", () => {
    const s = tvFitScale(VIEWPORT.w, VIEWPORT.h, 3);
    expect(s).toBeCloseTo(0.94, 10);
    // What the wall actually loses, in real pixels: 57.6px of black per side.
    expect((VIEWPORT.w - TV_W * s) / 2).toBeCloseTo(57.6, 6);
  });

  it("still letterboxes on a non-16:9 viewport, inset or not", () => {
    // Height-bound: a 1920×1200 panel fits on width, and the inset compounds.
    expect(tvFitScale(1920, 1200, 0)).toBe(1);
    expect(tvFitScale(1920, 1200, 5)).toBeCloseTo(0.9, 10);
  });

  it("NEVER returns zero or a negative scale, whatever it is handed", () => {
    const inputs: unknown[] = [
      0,
      3,
      10,
      100,
      1_000_000,
      -5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      undefined,
      null,
      "oops",
      {},
    ];
    for (const bad of inputs) {
      const s = tvFitScale(VIEWPORT.w, VIEWPORT.h, bad);
      expect(s).toBeGreaterThan(0);
      expect(Number.isFinite(s)).toBe(true);
    }
  });

  it("falls back to 1:1 rather than nothing when the viewport is unmeasurable", () => {
    // A hidden tab, or a paint before layout, reports 0 — and scale(0) is a wall
    // showing nothing, the one outcome worse than a mis-fitted one.
    expect(tvFitScale(0, 0)).toBe(1);
    expect(tvFitScale(Number.NaN, Number.NaN)).toBe(1);
    expect(tvFitScale(0, 0, 5)).toBeCloseTo(0.9, 10);
  });
});

describe("resolveScreenConfig — overscanPct", () => {
  it("is 0 for every screen that has never been told about it", () => {
    expect(resolveScreenConfig(null, "FT").overscanPct).toBe(0);
    expect(resolveScreenConfig({}, "HPFM").overscanPct).toBe(0);
  });

  it("is 0 for every role preset — a preset must not inset anybody's wall", () => {
    for (const preset of ROLE_PRESETS) {
      expect(resolveScreenConfig(preset.config, preset.venues[0]).overscanPct).toBe(0);
    }
    expect(resolveScreenConfig(rolePreset("briefing-room").config, "FT").overscanPct).toBe(0);
  });

  it("carries a real correction through", () => {
    expect(resolveScreenConfig({ overscanPct: 3 }, "FT").overscanPct).toBe(3);
    expect(resolveScreenConfig({ overscanPct: 1.5 }, "FT").overscanPct).toBe(1.5);
  });

  it("clamps garbage instead of throwing — the resolver never rejects a config", () => {
    const nasty: ScreenConfig[] = [
      { overscanPct: 999 },
      { overscanPct: -4 },
      { overscanPct: Number.NaN },
      { overscanPct: "3" as unknown as number },
      { overscanPct: null as unknown as number },
    ];
    for (const cfg of nasty) {
      const r = resolveScreenConfig(cfg, "FT");
      expect(r.overscanPct).toBeGreaterThanOrEqual(0);
      expect(r.overscanPct).toBeLessThanOrEqual(TV_MAX_OVERSCAN_PCT);
      // And the rest of the config still resolves — one bad number must not cost
      // a screen its playlist.
      expect(r.playlist.length).toBeGreaterThan(0);
    }
  });

  it("does not disturb anything else on the screen", () => {
    const withInset = resolveScreenConfig(
      { playlist: [{ scene: "briefing" }], briefingRoom: "red", overscanPct: 4 },
      "FT",
    );
    const without = resolveScreenConfig(
      { playlist: [{ scene: "briefing" }], briefingRoom: "red" },
      "FT",
    );
    expect({ ...withInset, overscanPct: 0 }).toEqual(without);
  });
});
