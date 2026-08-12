import { describe, expect, it } from "vitest";
import { buildReturnAnnouncement, shouldAnnounceReturn } from "./return-announce.server";

describe("shouldAnnounceReturn — Mega days only (owner 2026-08-12)", () => {
  it("announces a Mega-track return", () => {
    expect(shouldAnnounceReturn("mega")).toBe(true);
  });

  it("stays SILENT on an ordinary red or blue track day", () => {
    // The whole point of the gate: the rooms are still named red/blue on a Mega
    // day, so this must key off the TRACK the session ran on, never the room.
    expect(shouldAnnounceReturn("red")).toBe(false);
    expect(shouldAnnounceReturn("blue")).toBe(false);
  });

  it("stays silent when the track is missing or unrecognised", () => {
    expect(shouldAnnounceReturn(null)).toBe(false);
    expect(shouldAnnounceReturn(undefined)).toBe(false);
    expect(shouldAnnounceReturn("")).toBe(false);
    expect(shouldAnnounceReturn("Mega")).toBe(false); // stored lowercase; no fuzzy match
  });
});

describe("buildReturnAnnouncement — the exact contract the owner supplied", () => {
  it('says "58 returning to blue"', () => {
    expect(buildReturnAnnouncement({ room: "blue", heatNumber: 58 })).toEqual({
      server: "FT",
      // The venue's new dedicated track-announcements bot — "FT - Track Bot"
      // on the live service's /health/zello. Never FOH: that's guest assist.
      target: "Track Bot",
      priority: 1,
      message: "58 returning to blue",
      name: "BriefingReturn-blue",
      cooldown: 60,
    });
  });

  it("names the red room's returns separately, so the two rooms never dedupe each other", () => {
    const red = buildReturnAnnouncement({ room: "red", heatNumber: 61 });
    expect(red.message).toBe("61 returning to red");
    expect(red.name).toBe("BriefingReturn-red");
  });

  it("still announces a heat the record lost the number for", () => {
    expect(buildReturnAnnouncement({ room: "red", heatNumber: null }).message).toBe(
      "Race returning to red",
    );
  });
});
