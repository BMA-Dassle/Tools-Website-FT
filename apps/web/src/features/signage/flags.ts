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
