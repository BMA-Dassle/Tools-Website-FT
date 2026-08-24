import { describe, it, expect } from "vitest";
import { fillsPanel, PANEL_FILL_TOLERANCE_PX } from "./fullscreen";

/** A 1080p panel, the shape almost every board in the estate is. */
const PANEL = { screenW: 1920, screenH: 1080 };

describe("fillsPanel", () => {
  it("says yes for a board launched the way the launchers launch them", () => {
    // Edge kiosk mode and --start-fullscreen both give the window the whole
    // monitor. This is 17 of 19 screens on an ordinary night.
    expect(fillsPanel({ innerW: 1920, innerH: 1080, ...PANEL })).toBe(true);
  });

  it("says no for windowed Edge, which is the whole point", () => {
    // Tab strip + address bar is ~85-120px before any taskbar. This is what a
    // staff member sees after opening the URL by hand, and what a board knocked
    // out of fullscreen with Esc or F11 looks like.
    expect(fillsPanel({ innerW: 1920, innerH: 1080 - 88, ...PANEL })).toBe(false);
    expect(fillsPanel({ innerW: 1280, innerH: 720, ...PANEL })).toBe(false);
  });

  it("tolerates a fractional shortfall but not real chrome", () => {
    expect(fillsPanel({ innerW: 1920, innerH: 1080 - PANEL_FILL_TOLERANCE_PX, ...PANEL })).toBe(
      true,
    );
    expect(fillsPanel({ innerW: 1920, innerH: 1080 - PANEL_FILL_TOLERANCE_PX - 1, ...PANEL })).toBe(
      false,
    );
    // A 150%-scaled display can report the viewport a fraction short.
    expect(fillsPanel({ innerW: 1919.5, innerH: 1079.5, ...PANEL })).toBe(true);
  });

  it("catches a window that is full height but not full width", () => {
    // Two boards side by side on one monitor, or a half-width snap. Full height
    // alone would have called this fine.
    expect(fillsPanel({ innerW: 960, innerH: 1080, ...PANEL })).toBe(false);
  });

  it("does not complain when the viewport is BIGGER than the reported screen", () => {
    // Some engines report the primary monitor while the window sits on a larger
    // secondary — the two-monitor players are exactly this shape. A shortfall is
    // the only thing that counts.
    expect(fillsPanel({ innerW: 3840, innerH: 2160, ...PANEL })).toBe(true);
  });

  it("assumes the best when it cannot measure", () => {
    // A FALSE POSITIVE COSTS SOMEBODY A DRIVE TO A VENUE, so an unreadable
    // screen reading must never read as windowed. Old engine, headless run,
    // preview harness — all say "filling".
    expect(fillsPanel({ innerW: 1920, innerH: 1080, screenW: 0, screenH: 0 })).toBe(true);
    expect(fillsPanel({ innerW: 0, innerH: 0, ...PANEL })).toBe(true);
    expect(fillsPanel({ innerW: Number.NaN, innerH: 1080, ...PANEL })).toBe(true);
    expect(
      fillsPanel({ innerW: 1920, innerH: 1080, screenW: 1920, screenH: Number.POSITIVE_INFINITY }),
    ).toBe(true);
  });

  it("honours a caller-supplied tolerance", () => {
    expect(fillsPanel({ innerW: 1920, innerH: 1000, ...PANEL, tolerancePx: 100 })).toBe(true);
    expect(fillsPanel({ innerW: 1920, innerH: 1000, ...PANEL, tolerancePx: 4 })).toBe(false);
  });

  it("works on a portrait panel too", () => {
    // Nothing here assumes landscape; the pit/briefing walls have been hung
    // both ways at one time or another.
    expect(fillsPanel({ innerW: 1080, innerH: 1920, screenW: 1080, screenH: 1920 })).toBe(true);
    expect(fillsPanel({ innerW: 1080, innerH: 1832, screenW: 1080, screenH: 1920 })).toBe(false);
  });
});
