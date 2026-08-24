import { describe, it, expect } from "vitest";
import { withAlpha } from "./color";
import { RECORD_TRACKS } from "~/lib/constants/race-records";

describe("withAlpha", () => {
  it("takes the signage palette's hex", () => {
    expect(withAlpha("#a06bff", 0.5)).toBe("rgba(160, 107, 255, 0.5)");
    expect(withAlpha("#000418", 1)).toBe("rgba(0, 4, 24, 1)");
  });

  it("is case-insensitive about hex", () => {
    expect(withAlpha("#A06BFF", 0.5)).toBe(withAlpha("#a06bff", 0.5));
  });

  it("takes rgb(), which is how the race-records catalog spells its colours", () => {
    // THE REGRESSION. These came back unchanged, so a header tinted with
    // withAlpha(color, 0.16) got a SOLID fill of the same colour the label was
    // written in — red on red, invisible on the wall (2026-08-18).
    expect(withAlpha("rgb(228,28,29)", 0.16)).toBe("rgba(228, 28, 29, 0.16)");
    expect(withAlpha("rgb(0, 74, 173)", 0.45)).toBe("rgba(0, 74, 173, 0.45)");
  });

  it("replaces an existing alpha rather than multiplying it", () => {
    expect(withAlpha("rgba(134,82,255,0.9)", 0.2)).toBe("rgba(134, 82, 255, 0.2)");
  });

  it("returns anything it cannot parse unchanged, so a token still renders", () => {
    expect(withAlpha("var(--tv-accent)", 0.5)).toBe("var(--tv-accent)");
    expect(withAlpha("transparent", 0.5)).toBe("transparent");
    // Guards against the regex matching a malformed string into nonsense.
    expect(withAlpha("#abc", 0.5)).toBe("#abc");
    expect(withAlpha("rgb(1,2)", 0.5)).toBe("rgb(1,2)");
  });

  it("EVERY tier colour the top-times board renders is actually alpha-able", () => {
    // The board tints and rules with these; one that fell through would be
    // invisible text again. Asserted against the real catalog, not a fixture.
    for (const track of RECORD_TRACKS) {
      for (const c of [...track.adult, ...track.junior]) {
        expect(withAlpha(c.color, 0.16), `${track.key} ${c.label} color`).toMatch(
          /^rgba\(\d+, \d+, \d+, 0\.16\)$/,
        );
      }
    }
  });
});
