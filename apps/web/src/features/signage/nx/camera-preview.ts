/**
 * What the desk asks a camera for — the mode, the resolution, and what each
 * costs. Vocabulary only; nothing here talks to Nx or to Redis.
 *
 * Client-safe on purpose. Both modules that own the I/O are `server-only` —
 * camera.server.ts holds the Nx credentials, camera-preview-setting.server.ts
 * holds the Redis key — but the desk panels have to name a mode and a
 * resolution, and a component may not import either module to do it.
 *
 * 720p IS THE ONE ASK THAT IS NOT WHAT IT SOUNDS LIKE. Measured against
 * production 2026-08-16, blue briefing-room camera, 20s samples through the
 * relay:
 *
 *   ask       picture      fps    rate       what it actually is
 *   720p      1280x720       2    24 KB/s    the camera's SUBSTREAM, verbatim
 *   1080p    1440x1080      19   589 KB/s    a transcode off the primary
 *   480p       640x480      20    60 KB/s    ditto, at a tile's size
 *   360p       480x360      20    78 KB/s    ditto — no cheaper than 480p
 *   (none)   2592x1944      20   797 KB/s    the raw primary, passthrough
 *
 * Nx satisfies a 720p ask from the camera's secondary stream, and these units
 * publish that at 2 fps. Every OTHER ask transcodes the 20fps primary and moves
 * properly. So 720p — the default this code shipped with, and what the
 * full-screen viewer has been playing since August 12 — is a slideshow, which is
 * why "LIVE" there looked barely different from the 1 fps stills underneath it.
 * (`stream=1` is the same 2 fps substream by another name.)
 *
 * Below 480p buys nothing: 360p measured no cheaper, because bitrate here tracks
 * how much the room is moving, not pixel count.
 *
 * The cost of motion is a transcode session per stream on the NVR, which is the
 * scarce resource — a dewarped 1600px still already measured 8.5s to answer. Ask
 * for motion where someone is actually watching; leave everything else on stills.
 */
export type LiveResolution = "360p" | "480p" | "720p" | "1080p";

export const LIVE_RESOLUTIONS: readonly LiveResolution[] = ["360p", "480p", "720p", "1080p"];

/**
 * What the desk's small camera previews ask for: the moving picture, at a size
 * the tile is already oversampling (the box is ~208px wide, 640x480 fills it
 * twice over). Going lower buys nothing a staff member can see and still costs
 * the NVR a transcode.
 */
export const MOTION_RESOLUTION: LiveResolution = "480p";

/**
 * What the full-screen viewer asks for. It is the one surface where somebody is
 * deliberately WATCHING a room — deciding whether everyone is seated and
 * helmeted — so it gets the sharp moving picture and the bandwidth that costs
 * (~590 KB/s), for as long as the overlay is open and not a second longer.
 *
 * 720p would be a tenth of the traffic and two frames a second; that trade is
 * what this whole module exists to make legible.
 */
export const VIEWER_RESOLUTION: LiveResolution = "1080p";

/** Unknown or absent → undefined, so a caller that names nothing keeps whatever
 *  default the server-side stream builder already had. */
export function parseLiveResolution(v: string | null | undefined): LiveResolution | undefined {
  return LIVE_RESOLUTIONS.find((r) => r === v);
}

/**
 * Whether the desk's room previews play video or fall back to a picture a
 * second — chosen once in the check-in settings sheet, applying to every
 * station. The Redis side lives in briefing/camera-preview-setting.server.ts;
 * the type is here because the panels reading it are client code.
 *
 * "stills" is not a broken state — it is the position to take when the NVR is
 * busy, and the tiles still show the room.
 */
export type CameraPreviewMode = "live" | "stills";

export const DEFAULT_CAMERA_PREVIEW_MODE: CameraPreviewMode = "live";

/** Anything unrecognised reads as the default rather than throwing: this parses
 *  a hand-editable Redis value, and a typo must not dark the previews. */
export function parseCameraPreviewMode(v: string | null | undefined): CameraPreviewMode {
  return v === "live" || v === "stills" ? v : DEFAULT_CAMERA_PREVIEW_MODE;
}

/**
 * THE ONE PARAMETER WITHOUT WHICH NO BROWSER CAN PLAY THIS: `videoCodec=h264`.
 *
 * Nx's transcoder emits **MPEG-4 Part 2** by default (`stsd` → `mp4v` + `esds`;
 * ffprobe calls it `mpeg4`, Simple Profile). Chrome has never decoded that. So
 * every transcoded stream we asked for was downloaded in full, parsed, and
 * refused — which looked exactly like a flaky camera: three attempts, ~2s each,
 * data flowing the whole time, then a silent fall back to stills. Only the
 * 720p SUBSTREAM escaped it, because that is passed through untouched and the
 * camera itself publishes H.264 (at 2fps, which is the other trap above).
 *
 * With `videoCodec=h264` the same request returns `avc1` + `avcC` (verified:
 * avc1.42C01F at 480p, avc1.42C02A at 1080p), and it is far CHEAPER, because
 * H.264 compresses what MPEG-4 Part 2 could not:
 *
 *   480p   60 KB/s as mp4v  ->   31 KB/s as h264
 *   1080p 589 KB/s as mp4v  ->  118 KB/s as h264
 *
 * `codec=` and `transcodingCodec=` are silently IGNORED by Nx — both come back
 * mpeg4. Only `videoCodec` is honoured, which is why this lives in one tested
 * place instead of being spelled out at a call site.
 */
export const LIVE_VIDEO_CODEC = "h264";

export interface LiveStreamParams {
  resolution: LiveResolution;
  ticket: string;
  dewarp?: {
    xAngle: number;
    yAngle: number;
    fov: number;
    panoFactor: number;
  };
}

/** The query for a live media.mp4, as a browser needs it. Pure so the codec
 *  cannot quietly go missing again — see the test. */
export function liveStreamQuery({ resolution, ticket, dewarp }: LiveStreamParams): URLSearchParams {
  const params = new URLSearchParams({
    resolution,
    videoCodec: LIVE_VIDEO_CODEC,
    _ticket: ticket,
  });
  if (dewarp) {
    params.set("dewarping", "true");
    params.set("dewarpingXangle", String(dewarp.xAngle));
    params.set("dewarpingYangle", String(dewarp.yAngle));
    params.set("dewarpingFov", String(dewarp.fov));
    params.set("dewarpingPanofactor", String(dewarp.panoFactor));
  }
  return params;
}
