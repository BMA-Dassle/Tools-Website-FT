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

/**
 * Camera-return-strip kill switch — the row of POV camera numbers along the
 * bottom of the briefing room TVs (briefing/camera-return.ts).
 *
 * Same house rule: defaults ON, read at call time. Turning it OFF stops the feed
 * carrying the strip, so the boards go back to using the full 1080 px and the
 * safety film stops being cropped. The switch to pull if the scan log or the
 * finish markers ever start lying — a strip showing four cameras red that are
 * sitting on the shelf would teach staff to ignore it, and that costs more than
 * having no strip.
 *
 * NOT a NEXT_PUBLIC_ var: only the server decides whether to put the data on the
 * rail, and the scene renders nothing when it is absent. Flipping it is an env
 * change with no rebuild.
 */
export function cameraReturnBarEnabled(): boolean {
  return process.env.SIGNAGE_CAMERA_RETURN_ENABLED !== "false";
}

/**
 * Race-results-board kill switch — the scores walls at the kart returns.
 *
 * Same house rule: defaults ON, read at call time. Turning it OFF stops the
 * feed carrying the section, so the boards fall back to their idle card and
 * stop asking Pandora for a session list every poll. The switch to pull if the
 * standings capture ever starts putting the WRONG heat's names on a wall —
 * the heat-match gate makes that unlikely, but a results board naming the
 * wrong racers in front of them is the kind of wrong that is worse than blank.
 *
 * NOT a NEXT_PUBLIC_ var: only the server decides whether to build the
 * section, and the scene renders its idle card when it is absent. Flipping it
 * is an env change with no rebuild.
 */
export function resultsBoardEnabled(): boolean {
  return process.env.SIGNAGE_RESULTS_ENABLED !== "false";
}

/**
 * Check-in guide wall kill switch.
 *
 * Same house rule: defaults ON, read at call time. This one is NEXT_PUBLIC
 * because the scene is entirely client-side — it renders from the feed section
 * the check-in boards already carry, so there is no server work to withhold and
 * the switch has to reach the component itself. Turning it OFF drops the scene
 * back to house ads rather than darkening the panel.
 *
 * The switch to pull if the wayfinding arrow is ever pointing the wrong way:
 * a confident arrow to the wrong room is worse than no arrow at all, and worse
 * than an advert.
 */
export function raceGuideEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SIGNAGE_GUIDE_ENABLED !== "false";
}

/**
 * HP Arena check-in board kill switch — the called-session takeover at
 * HeadPinz Fort Myers and Naples, and the Pandora read behind it.
 *
 * Same house rule: defaults ON, read at call time. Turning it OFF stops the feed
 * carrying the `arena` section, so the board never takes the check-in interrupt
 * and simply runs its films and house slides — which is a perfectly good lobby
 * screen, just not a check-in one. That is the point: the failure mode of this
 * switch is a screen that sells rather than a screen that is wrong.
 *
 * The switch to pull if `sessions/current` ever starts reporting a called
 * session that is not really called. An arena board is an INSTRUCTION — it
 * tells a group to walk to a desk — and an instruction nobody at that desk is
 * expecting is worse than an advert.
 *
 * NOT a NEXT_PUBLIC_ var: only the server decides whether to build the section,
 * and the scene is never selected without it. Flipping it is an env change with
 * no rebuild.
 */
export function arenaBoardEnabled(): boolean {
  return process.env.SIGNAGE_ARENA_ENABLED !== "false";
}
