/**
 * When does a briefing room greet its group BACK? PURE — numbers in, boolean out.
 *
 * The flow (owner 2026-08-11): a group is briefed, races, and walks back into the
 * SAME room to return kit. The wall should say welcome back — return helmets to
 * the shelves, cameras to the attendant, restate the qualifying time, and say
 * where the scores are posted.
 *
 * THE SIGNAL IS THE TIMING SYSTEM'S OWN `actualEnd`, not a guess (owner: "we know
 * exactly when a session finishes — don't guess"). The VIP experience board
 * already reads it: Pandora's per-track sessions list stamps actualStart/actualEnd
 * when the timing system starts and ends a heat, and
 * reservations-admin/race-live-state.server keeps a cron-warmed, memory-cached
 * reader over it. A first cut here derived the moment from "the next heat was
 * called" plus elapsed time; that heuristic is deleted, not layered under this.
 *
 * The window opens AT the session's actual end and holds long enough for the walk
 * back and the kit return, then the room falls back to helmet sizes — a greeting
 * left up into the evening is just wrong signage. The board itself only shows
 * while the room is otherwise IDLE: a playing video, a take-a-seat hold or the
 * helmet phase all outrank it (owner: "AS LONG AS A VIDEO IS NOT PLAYING").
 */

/**
 * Is the welcome-back window open for a session that actually ended at
 * `actualEndMs`? Null/unparseable means the session has not ended — the timing
 * system stamps the field only when the heat truly stops.
 *
 * NO TIME CEILING, deliberately (owner 2026-08-11: "the return screen can stay
 * up till the next briefing video plays"). What retires the greeting is the
 * room's own life, not a clock: the next send occupies the room (any live
 * timeline outranks this board), and the resolver always reads the LATEST
 * briefed group, so an older group's greeting can never outlive a newer one.
 * The business-day scope on the assignment lookup is what stops yesterday's
 * greeting reappearing tomorrow.
 */
export function welcomeBackWindowOpen(actualEndMs: number | null): boolean {
  return actualEndMs != null && Number.isFinite(actualEndMs);
}
