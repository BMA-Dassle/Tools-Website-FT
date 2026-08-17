import "server-only";

/**
 * HOW HARD THE DESK'S CAMERA PREVIEWS WORK THE NVR — chosen once in the check-in
 * board's settings sheet, and applying to every station, exactly like the
 * auto-holding and race-bookmark switches beside it.
 *
 * A CHOICE, NOT A KILL SWITCH, which is why this one stores a word rather than
 * "1"/"0". Both settings are legitimate operating positions:
 *
 *   live    the room tiles play moving video (480p/20fps, ~60 KB/s each), which
 *           costs the Nx server ONE TRANSCODE SESSION PER TILE PER STATION.
 *   stills  the tiles go back to a picture a second through our own proxy. No
 *           transcode at all, and the tiles still show the room.
 *
 * The reason it has to be switchable AT THE DESK is that the ceiling is the
 * NVR's, not ours, and nobody knows where it is yet: a dewarped still already
 * measured 8.5s to answer when the box was busy, and transcode sessions do not
 * share — four stations watching the same room are four transcodes. If a Mega
 * Saturday makes the cameras crawl, staff need to drop to stills at 9pm without
 * waiting for a deploy. See nx/live-resolution.ts for the measurements.
 *
 * House rules, same as its neighbours: DEFAULT LIVE (the feature is on when it
 * ships — a merged feature is on), only an explicit recognised word changes it,
 * an unreachable Redis reads as the default, and NO TTL. Anything unrecognised —
 * a hand-edited key, a value written by a newer deploy — reads as the default
 * rather than throwing, so a typo in redis-cli cannot dark the previews.
 */
import redis from "@/lib/redis";
import {
  DEFAULT_CAMERA_PREVIEW_MODE,
  parseCameraPreviewMode,
  type CameraPreviewMode,
} from "../nx/camera-preview";

export type { CameraPreviewMode };

const SWITCH_KEY = `checkin:camera-preview:mode`;

export async function cameraPreviewMode(): Promise<CameraPreviewMode> {
  try {
    return parseCameraPreviewMode(await redis.get(SWITCH_KEY));
  } catch {
    return DEFAULT_CAMERA_PREVIEW_MODE;
  }
}

export async function setCameraPreviewMode(mode: CameraPreviewMode): Promise<void> {
  await redis.set(SWITCH_KEY, mode);
}
