import { describe, expect, it } from "vitest";
import { punctuality } from "./track-delay";

/** The case worth a test is the third one: a track the feed says nothing about
 *  must not read as a track that is running to time. */
describe("punctuality", () => {
  it("says on time at zero", () => {
    expect(punctuality({ delayMinutes: 0 })).toEqual({
      state: "on-time",
      label: "On time",
      minutes: 0,
    });
  });

  it("prefers the venue's own wording when it sends one", () => {
    expect(punctuality({ delayMinutes: 4, delayFormatted: "4 min" })).toEqual({
      state: "late",
      label: "4 min behind",
      minutes: 4,
    });
  });

  it("words it itself when the feed does not", () => {
    expect(punctuality({ delayMinutes: 12 }).label).toBe("12 min behind");
    expect(punctuality({ delayMinutes: 12, delayFormatted: "  " }).label).toBe("12 min behind");
  });

  it("never reports an unknown track as punctual", () => {
    expect(punctuality(null).state).toBe("unknown");
    expect(punctuality(undefined).state).toBe("unknown");
    expect(punctuality({ delayMinutes: Number.NaN }).state).toBe("unknown");
  });

  it("treats a track ahead of itself as on time, not as negative lateness", () => {
    expect(punctuality({ delayMinutes: -3 })).toMatchObject({ state: "on-time", minutes: 0 });
  });
});
