/**
 * WHICH CAMERAS COVER WHICH TRACK. PURE — matching only, no network.
 *
 * WHY BY NAME AND NOT A LIST OF IDS (owner 2026-08-14: "I'd like you to write
 * this to all the cameras for that track"). The venue has 162 devices and the
 * karting ones are named to a strict scheme — `FT Track - Blue - Turn 7`,
 * `FT Track - Red Pit - Row 1 - Mid`. A hardcoded id list would be correct for
 * exactly as long as nobody adds, replaces or renames a camera, and the failure
 * when that happens is SILENT: a race simply stops being marked on the new
 * camera and nobody notices for months. Matching the naming scheme means a
 * camera added to the blue track next year is marked from the day it appears.
 *
 * THE DOUBLE-SPACE IS REAL, NOT A TYPO IN THIS FILE. Three devices are named
 * `FT Track - Red  - Down Slope`, `FT Track - Red  - End Hairpin` and
 * `FT Track - Red  - Level 3` with two spaces after "Red" (verified against the
 * live device list 2026-08-14). Any matcher built on the exact string
 * `"FT Track - Red - "` silently drops all three, which is exactly the class of
 * bug this comment exists to prevent — so the separator is `\s+`.
 *
 * PIT CAMERAS COUNT AS THE TRACK. A session's story starts on the grid and ends
 * in the pit lane, and the pit rows are where an incident involving a stationary
 * kart or a person on foot will be. `FT Track - Blue Pit - Row 4 - Front` is as
 * much a part of blue's race as turn 7.
 *
 * MEGA IS BOTH. A Mega heat runs the blue and red circuits joined, so its
 * cameras are the union — the same reason both briefing rooms serve Mega.
 */

export type CameraTrack = "blue" | "red" | "mega";

/** The shape listCameras() returns, narrowed to what matching needs. */
export interface NamedCamera {
  id: string;
  name: string;
  status?: string | null;
}

/**
 * `FT Track - <colour>` with any run of whitespace, and the colour must end at a
 * word boundary so "Red" does not also catch a hypothetical "Redemption" camera
 * — `FT Redemption` exists at two other centers and is precisely the trap.
 * "Pit" is allowed to follow the colour so `Blue Pit`/`Red Pit Exit` come along.
 */
function trackPattern(colour: "Blue" | "Red"): RegExp {
  return new RegExp(`^FT\\s+Track\\s*-\\s*${colour}\\b`, "i");
}

/**
 * Is this camera on the given track?
 *
 * OFFLINE CAMERAS ARE EXCLUDED, and that is a correctness decision rather than
 * an optimisation: a bookmark on a camera with no footage behind it is a marker
 * pointing at nothing, which is worse than no marker — somebody following it
 * during an incident review would conclude the moment was not captured, when in
 * fact that device was simply down. `FT Track - Red - Hairpin Turn 2` was
 * offline when this was written.
 */
export function cameraOnTrack(camera: NamedCamera, track: CameraTrack): boolean {
  if (!camera.id || !camera.name) return false;
  if (camera.status && camera.status.toLowerCase() === "offline") return false;
  const blue = trackPattern("Blue").test(camera.name);
  const red = trackPattern("Red").test(camera.name);
  if (track === "blue") return blue;
  if (track === "red") return red;
  return blue || red; // mega runs the joined circuit
}

/** Every camera covering a track, in a stable order so logs and claims read the
 *  same way twice. */
export function camerasForTrack(cameras: NamedCamera[], track: CameraTrack): NamedCamera[] {
  return cameras
    .filter((c) => cameraOnTrack(c, track))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Narrow an arbitrary track string to one this module can serve. Anything else
 *  — null, "", a track we do not have cameras for — is not markable. */
export function parseCameraTrack(track: string | null | undefined): CameraTrack | null {
  const t = (track ?? "").toLowerCase();
  return t === "blue" || t === "red" || t === "mega" ? t : null;
}
