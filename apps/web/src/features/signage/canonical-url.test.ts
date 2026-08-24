import { describe, it, expect } from "vitest";
import { canonicalTvPath, parseScreenKey } from "./constants";

/**
 * The URL a board rewrites itself to at boot, and comes back to on a reload.
 *
 * Two jobs, and the second one was broken for as long as the rewrite has
 * existed: it has to be canonical, and it has to not throw away the one flag
 * that makes a misbehaving screen diagnosable at the wall.
 */
describe("canonicalTvPath", () => {
  it("is the identity a reload comes back to", () => {
    // The whole reason the rewrite exists: whatever a player was originally
    // pointed at, a self-update hard reload must return to the same screen.
    expect(canonicalTvPath("HPFM", 2)).toBe("/tv?screen=HPFM%3A2");
    expect(canonicalTvPath("FT", 11)).toBe("/tv?screen=FT%3A11");
  });

  it("round-trips back to the screen it names", () => {
    for (const [venue, n] of [
      ["HPFM", 2],
      ["HPFM", 8],
      ["FT", 1],
    ] as const) {
      const path = canonicalTvPath(venue, n);
      const key = decodeURIComponent(new URLSearchParams(path.split("?")[1]).get("screen")!);
      expect(parseScreenKey(key)).toEqual({ venue, screenNumber: n });
    }
  });

  it("KEEPS ?debug=1 — dropping it made the pane paint once and vanish", () => {
    // THE BUG, found smoking the preview in real Edge: TvApp reads `debug` off
    // the live window.location.search on EVERY render, and the boot effect
    // replaceStates to the canonical URL immediately. Canonicalising the param
    // away meant the debug pane appeared for one render and then disappeared —
    // on the one surface where it is the only way to ask a screen what it
    // thinks it is doing.
    expect(canonicalTvPath("HPFM", 2, { debug: true })).toBe("/tv?screen=HPFM%3A2&debug=1");
    // And it survives the round trip, so a self-update reload comes back in debug.
    const params = new URLSearchParams(canonicalTvPath("HPFM", 2, { debug: true }).split("?")[1]);
    expect(params.has("debug")).toBe(true);
    expect(decodeURIComponent(params.get("screen")!)).toBe("HPFM:2");
  });

  it("adds nothing when debug is off, so the resting URL stays canonical", () => {
    // If this ever differed from the no-arg form, every board would replaceState
    // on every boot for no reason.
    expect(canonicalTvPath("HPFM", 2, {})).toBe(canonicalTvPath("HPFM", 2));
    expect(canonicalTvPath("HPFM", 2, { debug: false })).toBe(canonicalTvPath("HPFM", 2));
    expect(canonicalTvPath("HPFM", 2)).not.toContain("debug");
  });

  it("does NOT carry demo — a pushed preview is meant to expire", () => {
    // Deliberate asymmetry with debug. TvApp captures demo into state before the
    // rewrite, so it survives this tab; it must not survive a reload.
    expect(canonicalTvPath("HPFM", 2, { debug: true })).not.toContain("demo");
  });
});
