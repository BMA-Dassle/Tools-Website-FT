import { describe, expect, it } from "vitest";
import { assetKeyForTier, resolveFilmTier, tierForRaceType, type BriefingTier } from "./types";

describe("tierForRaceType — which film a session asks for", () => {
  it("Pro sessions ask for the Pro film (owner 2026-08-11, superseding Pro→Starter)", () => {
    expect(tierForRaceType("Pro")).toBe("pro");
    expect(tierForRaceType("pro")).toBe("pro");
  });

  it("Junior Pro asks for the Pro film too — junior gates heats, not briefings", () => {
    expect(tierForRaceType("Junior Pro")).toBe("pro");
  });

  it("intermediate wins over pro in the match order, so nothing mislabels", () => {
    expect(tierForRaceType("Intermediate")).toBe("intermediate");
    expect(tierForRaceType("Intermediate (2)")).toBe("intermediate");
    expect(tierForRaceType("Junior Intermediate")).toBe("intermediate");
  });

  it("starter and the unrecognised get the full briefing", () => {
    expect(tierForRaceType("Starter")).toBe("starter");
    expect(tierForRaceType("Junior Starter")).toBe("starter");
    expect(tierForRaceType("Corporate Event")).toBe("starter");
    expect(tierForRaceType(null)).toBe("starter");
  });
});

describe("resolveFilmTier — which film the room actually plays", () => {
  const has = (present: BriefingTier[]) => (t: BriefingTier) => present.includes(t);

  it("plays the Pro film when it exists", () => {
    expect(resolveFilmTier("pro", has(["starter", "intermediate", "pro"]))).toBe("pro");
  });

  it("THE REQUIREMENT: Pro falls back to Intermediate when no Pro film exists", () => {
    expect(resolveFilmTier("pro", has(["starter", "intermediate"]))).toBe("intermediate");
  });

  it("keeps the honest answer when neither Pro nor Intermediate exists", () => {
    // A missing film becomes the helmet board (and the desk says so) — it must
    // NOT chain to the Starter film, which would show first-timer content to an
    // experienced grid.
    expect(resolveFilmTier("pro", has(["starter"]))).toBe("pro");
  });

  it("starter and intermediate never fall back anywhere", () => {
    expect(resolveFilmTier("starter", has([]))).toBe("starter");
    expect(resolveFilmTier("intermediate", has([]))).toBe("intermediate");
    expect(resolveFilmTier("intermediate", has(["starter", "pro"]))).toBe("intermediate");
  });
});

describe("assetKeyForTier", () => {
  it("maps every tier to its own slot", () => {
    expect(assetKeyForTier("starter")).toBe("briefing-video:starter");
    expect(assetKeyForTier("intermediate")).toBe("briefing-video:intermediate");
    expect(assetKeyForTier("pro")).toBe("briefing-video:pro");
  });
});
