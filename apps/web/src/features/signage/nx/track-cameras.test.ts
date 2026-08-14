import { describe, expect, it } from "vitest";
import { cameraOnTrack, camerasForTrack, parseCameraTrack } from "./track-cameras";

/**
 * Names taken VERBATIM from the live Nx device list (162 devices, read
 * 2026-08-14) — including the three red cameras with a double space after
 * "Red", which is the whole reason the matcher uses `\s+`.
 */
const DEVICES = [
  { id: "b1", name: "FT Track - Blue - Turn 1", status: "Recording" },
  { id: "b2", name: "FT Track - Blue - Turn 11", status: "Recording" },
  { id: "b3", name: "FT Track - Blue - Finishline/Pit Out", status: "Recording" },
  { id: "b4", name: "FT Track - Blue Pit - Row 4 - Front", status: "Recording" },
  { id: "r1", name: "FT Track - Red - Turn 1", status: "Recording" },
  { id: "r2", name: "FT Track - Red  - Down Slope", status: "Recording" },
  { id: "r3", name: "FT Track - Red  - End Hairpin", status: "Recording" },
  { id: "r4", name: "FT Track - Red Pit Exit", status: "Recording" },
  { id: "r5", name: "FT Track - Red - Hairpin Turn 2", status: "Offline" },
  { id: "x1", name: "FT Karting - Briefing - Blue", status: "Recording" },
  { id: "x2", name: "FT Track - Checkin", status: "Recording" },
  { id: "x3", name: "FT Track - Mini Track - North", status: "Recording" },
  { id: "x4", name: "FT Redemption", status: "Recording" },
  { id: "x5", name: "HPN Redemption", status: "Recording" },
  { id: "x6", name: "FT Nemos - Bar - Left", status: "Recording" },
];

describe("camerasForTrack", () => {
  it("takes the blue circuit and its pit, and nothing else", () => {
    expect(camerasForTrack(DEVICES, "blue").map((c) => c.id)).toEqual(["b3", "b1", "b2", "b4"]);
  });

  /** The double-space names are real devices; a matcher on the exact string
   *  "FT Track - Red - " silently loses three cameras. */
  it("matches the double-spaced red cameras", () => {
    const red = camerasForTrack(DEVICES, "red").map((c) => c.id);
    expect(red).toContain("r2");
    expect(red).toContain("r3");
  });

  /** A Mega heat runs the joined circuit, so it marks both. */
  it("gives mega the union of blue and red", () => {
    const mega = camerasForTrack(DEVICES, "mega")
      .map((c) => c.id)
      .sort();
    expect(mega).toEqual(["b1", "b2", "b3", "b4", "r1", "r2", "r3", "r4"]);
  });

  /**
   * A marker on a camera with no footage behind it points at nothing, and
   * would read during an incident review as "the moment was not captured".
   */
  it("excludes an offline camera", () => {
    expect(camerasForTrack(DEVICES, "red").map((c) => c.id)).not.toContain("r5");
  });

  /** "FT Redemption" is the trap a naive /Red/ match falls into. */
  it("does not mistake Redemption for the red track", () => {
    const all = camerasForTrack(DEVICES, "mega").map((c) => c.id);
    expect(all).not.toContain("x4");
    expect(all).not.toContain("x5");
  });

  it("leaves the briefing rooms, check-in and the mini track out", () => {
    const all = camerasForTrack(DEVICES, "mega").map((c) => c.id);
    for (const id of ["x1", "x2", "x3", "x6"]) expect(all).not.toContain(id);
  });

  it("skips rows with no id or no name", () => {
    expect(cameraOnTrack({ id: "", name: "FT Track - Blue - Turn 1" }, "blue")).toBe(false);
    expect(cameraOnTrack({ id: "b9", name: "" }, "blue")).toBe(false);
  });

  it("treats a camera with no status as usable", () => {
    expect(cameraOnTrack({ id: "b9", name: "FT Track - Blue - Turn 4" }, "blue")).toBe(true);
  });
});

describe("parseCameraTrack", () => {
  it("takes the three tracks we have cameras for", () => {
    expect(parseCameraTrack("blue")).toBe("blue");
    expect(parseCameraTrack("RED")).toBe("red");
    expect(parseCameraTrack("mega")).toBe("mega");
  });

  it("refuses anything else, so an unknown track is simply not marked", () => {
    expect(parseCameraTrack(null)).toBeNull();
    expect(parseCameraTrack("")).toBeNull();
    expect(parseCameraTrack("mini")).toBeNull();
  });
});
