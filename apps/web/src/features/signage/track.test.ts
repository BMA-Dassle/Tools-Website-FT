import { describe, it, expect } from "vitest";
import {
  TRACK_RESOURCE_IDS,
  effectiveTrack,
  findTrackDelay,
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

describe("findTrackDelay", () => {
  const FEED = [
    { trackName: "Blue Track", delayMinutes: 0, delayFormatted: "On time" },
    { trackName: "Red Track", delayMinutes: 12, delayFormatted: "12 min behind" },
  ];

  it("matches each track's row by name", () => {
    expect(findTrackDelay(FEED, "blue")?.delayFormatted).toBe("On time");
    expect(findTrackDelay(FEED, "red")?.delayMinutes).toBe(12);
  });

  it("REGRESSION: real names match - the template-literal backspace bug matched nothing", () => {
    // The check-in board built its regex in a template string where a
    // backslash-b is U+0008 BACKSPACE, so the pattern could never match a
    // track name and that board's delay line never rendered. This pins the
    // fixed behavior: ordinary upstream names DO match.
    expect(findTrackDelay(FEED, "blue")).not.toBeNull();
    expect(
      findTrackDelay([{ trackName: "blue", delayMinutes: 3, delayFormatted: "3 min" }], "blue")
        ?.delayMinutes,
    ).toBe(3);
  });

  it("mega with no upstream row falls back to the first row — the home-page precedent", () => {
    expect(findTrackDelay(FEED, "mega")?.delayFormatted).toBe("On time");
  });

  it("mega with an explicit Mega row takes that row, not the fallback", () => {
    const withMega = [
      { trackName: "Mega Track", delayMinutes: 5, delayFormatted: "5 min behind" },
      ...FEED,
    ];
    expect(findTrackDelay(withMega, "mega")?.delayMinutes).toBe(5);
  });

  it("blue and red never leak another track's row", () => {
    const redOnly = [{ trackName: "Red Track", delayMinutes: 9, delayFormatted: "9 min" }];
    expect(findTrackDelay(redOnly, "blue")).toBeNull();
  });

  it("empty or missing feeds report nothing", () => {
    expect(findTrackDelay(undefined, "blue")).toBeNull();
    expect(findTrackDelay([], "mega")).toBeNull();
  });
});
