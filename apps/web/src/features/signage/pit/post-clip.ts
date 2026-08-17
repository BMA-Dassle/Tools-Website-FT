/**
 * WHICH POST-RACE CLIP SOUNDS — the room phrase, then the safety net. PURE.
 *
 * The post announcement calls a returning group back to their briefing room,
 * and on a Mega night two rooms serve the one circuit, so a generic "return
 * to your briefing room" tells them nothing (owner 2026-08-16: "post decides
 * dynamically which room phrase it uses"). The room is the same recorded fact
 * everything else reads — the lane's pitIn slot carries it from the send.
 *
 * CANDIDATES IN ORDER, GENERIC LAST, ALWAYS. The room variants play BY FILE
 * (qsys.server's POST_ROOM_FILES — an upload to the Core's media drive, no
 * clip config, owner 2026-08-16); until those files exist — and against a
 * renamed or missing file after — a failed room play falls through to the
 * generic `post`, because a returning group hearing the plain announcement
 * beats one hearing nothing. The caller spends ONE `post` one-shot whichever
 * candidate sounds (the clip/cue split the big-race pre established).
 */
export function postClipCandidates(
  room: "red" | "blue" | null | undefined,
): ("post-red" | "post-blue" | "post")[] {
  if (room === "red") return ["post-red", "post"];
  if (room === "blue") return ["post-blue", "post"];
  return ["post"];
}
