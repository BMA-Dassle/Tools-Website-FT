import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAMERA_PREVIEW_MODE,
  MOTION_RESOLUTION,
  VIEWER_RESOLUTION,
  liveStreamQuery,
  parseCameraPreviewMode,
  parseLiveResolution,
} from "./camera-preview";

describe("parseCameraPreviewMode", () => {
  it("takes the two words it knows", () => {
    expect(parseCameraPreviewMode("live")).toBe("live");
    expect(parseCameraPreviewMode("stills")).toBe("stills");
  });

  /** This parses a hand-editable Redis value and a field that may be absent on a
   *  station running an older deploy. Neither may dark the previews. */
  it("falls back to the default rather than throwing on anything else", () => {
    for (const junk of [null, undefined, "", "LIVE", "1", "0", "true", "video", " live "]) {
      expect(parseCameraPreviewMode(junk)).toBe(DEFAULT_CAMERA_PREVIEW_MODE);
    }
  });

  it("defaults to live — a merged feature is on", () => {
    expect(DEFAULT_CAMERA_PREVIEW_MODE).toBe("live");
  });
});

describe("parseLiveResolution", () => {
  it("takes the four Nx accepts", () => {
    for (const r of ["360p", "480p", "720p", "1080p"] as const) {
      expect(parseLiveResolution(r)).toBe(r);
    }
  });

  /** Undefined, NOT a default: an unrecognised ?res= must leave the server-side
   *  stream builder's own choice standing rather than silently overriding it. */
  it("returns undefined for anything else", () => {
    for (const junk of [null, undefined, "", "4k", "1080", "720P", "high"]) {
      expect(parseLiveResolution(junk)).toBeUndefined();
    }
  });
});

/**
 * THE POINT OF THE WHOLE MODULE, pinned so a well-meaning "let's ask for the
 * bigger number" edit fails here first: on these cameras 720p is served from the
 * 2fps substream, so neither surface that wants MOTION may ask for it.
 */
describe("the resolutions the desk asks for", () => {
  it("never asks for 720p, which is the 2fps substream", () => {
    expect(MOTION_RESOLUTION).not.toBe("720p");
    expect(VIEWER_RESOLUTION).not.toBe("720p");
  });

  it("gives the tile the small transcode and the viewer the sharp one", () => {
    expect(MOTION_RESOLUTION).toBe("480p");
    expect(VIEWER_RESOLUTION).toBe("1080p");
  });
});

/**
 * THE REGRESSION THAT COST A DAY. Without `videoCodec=h264` Nx transcodes to
 * MPEG-4 Part 2, which no browser decodes — and the failure is silent, because
 * the stills fall back underneath and the network log looks perfect.
 */
describe("liveStreamQuery", () => {
  it("ALWAYS asks for h264 — Nx's default transcode is mp4v, which no browser plays", () => {
    const q = liveStreamQuery({ resolution: "480p", ticket: "vmsTicket-abc" });
    expect(q.get("videoCodec")).toBe("h264");
  });

  it("carries the resolution and the single-use ticket", () => {
    const q = liveStreamQuery({ resolution: "1080p", ticket: "vmsTicket-xyz" });
    expect(q.get("resolution")).toBe("1080p");
    expect(q.get("_ticket")).toBe("vmsTicket-xyz");
  });

  it("omits every dewarp key when there is no saved aim", () => {
    const q = liveStreamQuery({ resolution: "480p", ticket: "t" });
    for (const k of ["dewarping", "dewarpingXangle", "dewarpingYangle", "dewarpingFov"]) {
      expect(q.has(k)).toBe(false);
    }
  });

  /** Red and Blue holding are the SAME device at two aims, so the aim travelling
   *  with the stream is what stops one track's view showing the other's seats. */
  it("carries the saved aim when the camera is a dewarped fisheye", () => {
    const q = liveStreamQuery({
      resolution: "480p",
      ticket: "t",
      dewarp: { xAngle: 1.5, yAngle: -0.25, fov: 1.2, panoFactor: 2 },
    });
    expect(q.get("dewarping")).toBe("true");
    expect(q.get("dewarpingXangle")).toBe("1.5");
    expect(q.get("dewarpingYangle")).toBe("-0.25");
    expect(q.get("dewarpingFov")).toBe("1.2");
    expect(q.get("dewarpingPanofactor")).toBe("2");
  });
});
