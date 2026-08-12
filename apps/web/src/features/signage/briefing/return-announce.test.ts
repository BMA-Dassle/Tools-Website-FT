import { describe, expect, it } from "vitest";
import { buildReturnAnnouncement } from "./return-announce.server";

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
