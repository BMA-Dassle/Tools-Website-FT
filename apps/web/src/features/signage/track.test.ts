import { describe, it, expect } from "vitest";
import {
  TRACK_RESOURCE_IDS,
  effectiveTrack,
  megaPairing,
  trackFromName,
  trackFromResourceIds,
} from "./track";

describe("trackFromResourceIds", () => {
  it("resolves each track from its BMI resource id", () => {
    expect(trackFromResourceIds([TRACK_RESOURCE_IDS.blue])).toBe("blue");
    expect(trackFromResourceIds([TRACK_RESOURCE_IDS.red])).toBe("red");
    expect(trackFromResourceIds([TRACK_RESOURCE_IDS.mega])).toBe("mega");
  });

  it("returns null for a screen that is not a track screen", () => {
    // A lobby TV has no track scope. That is an answer, not a failure.
    expect(trackFromResourceIds(undefined)).toBeNull();
    expect(trackFromResourceIds([])).toBeNull();
    expect(trackFromResourceIds(["305133"])).toBeNull(); // HP Arena
  });
});

describe("trackFromName", () => {
  it("reads a track out of the names BMI and Pandora actually use", () => {
    expect(trackFromName("Blue Track")).toBe("blue");
    expect(trackFromName("Starter Race Red")).toBe("red");
    expect(trackFromName("Mega Track")).toBe("mega");
    expect(trackFromName("19 - Blue Junior Starter")).toBe("blue");
  });

  it("does not invent a track", () => {
    expect(trackFromName("HP Arena")).toBeNull();
    expect(trackFromName(null)).toBeNull();
    expect(trackFromName("")).toBeNull();
  });
});

describe("effectiveTrack", () => {
  it("follows the screen's own track on a normal day", () => {
    expect(effectiveTrack("blue", false)).toBe("blue");
    expect(effectiveTrack("red", false)).toBe("red");
  });

  it("follows Mega on a Mega day, whatever the screen is bolted to", () => {
    // On Tuesdays the barrier comes out and Blue/Red report no sessions at all.
    // A Blue screen that kept looking at `blue` would sit empty on the busiest
    // day of the week.
    expect(effectiveTrack("blue", true)).toBe("mega");
    expect(effectiveTrack("red", true)).toBe("mega");
  });

  it("stays null for a screen with no track", () => {
    expect(effectiveTrack(null, false)).toBeNull();
  });
});

describe("megaPairing", () => {
  const pair = { groupId: "ft-tracks", position: 1, count: 2 };

  it("engages only on a Mega day", () => {
    expect(megaPairing(pair, false)).toBeNull();
    expect(megaPairing(pair, true)).toEqual({ position: 1, count: 2 });
  });

  it("does nothing without a configured pairing", () => {
    expect(megaPairing(null, true)).toBeNull();
  });

  it("ignores a degenerate group of one", () => {
    expect(megaPairing({ groupId: "solo", position: 0, count: 1 }, true)).toBeNull();
  });
});

