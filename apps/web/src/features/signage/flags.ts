/**
 * Lobby-TV signage kill switch.
 *
 * HOUSE RULE — FLAGS ARE KILL SWITCHES ONLY (owner 2026-07-31). Defaults ON
 * (`!== "false"`), never an opt-in gate. Read at CALL TIME, never module scope,
 * so tests can stub process.env.
 *
 * The /tv URL is not linked from any nav; this is the emergency off switch for
 * a wall-mounted screen doing something wrong in front of guests, not an
 * exposure gate. Turning it off 404s the route — a dark panel is the correct
 * failure mode for signage (never a Next error page on a lobby wall).
 */
export function signageEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SIGNAGE_ENABLED !== "false";
}

/**
 * Briefing rooms kill switch — the video, the helmet board, the qualification
 * board, and the send buttons on the control board.
 *
 * Same house rule: defaults ON, read at call time. Turning it OFF stops the feed
 * carrying briefing data and makes a send a no-op, so the room TVs fall back to
 * their idle board and staff stop being offered a button that does nothing. It
 * does NOT dark the screens — a briefing room with a blank TV in it is worse than
 * one showing helmet sizes.
 */
export function briefingEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BRIEFING_ENABLED !== "false";
}

/**
 * Camera-monitor kill switch — the live-CCTV boards (a briefing room's own
 * camera on a wall) and the frame proxy that feeds them.
 *
 * Same house rule: defaults ON, read at call time. Turning it OFF makes
 * /api/tv/camera 404, so a camera board falls back to its "camera unavailable"
 * state rather than hammering the Nx relay — the switch to pull if the venue's
 * NVR or its cloud link is having a bad day and the boards are timing out.
 *
 * NOT a NEXT_PUBLIC_ var: nothing client-side needs to branch on it (the scene
 * simply asks the proxy and handles a 404), and keeping it server-only means
 * flipping it is an env change with no rebuild.
 */
export function cameraMonitorEnabled(): boolean {
  return process.env.SIGNAGE_CAMERA_ENABLED !== "false";
}
