/**
 * CLEARING THE CALLED HEAT, AND MAKING IT STICK.
 *
 * The desk can clear the called record from the Override panel, and until now
 * that press did nothing you could see: the clear deleted
 * `pandora:last-race:fasttrax:{track}`, and /api/pandora/races-current — which
 * polls constantly and writes that key unconditionally — put Pandora's answer
 * straight back within seconds. Pandora keeps reporting a called heat for about
 * 20 minutes, so "Clear" was unclearable for 20 minutes (owner 2026-08-14:
 * "always is shown as called session, can never clear called section").
 *
 * So a clear now leaves a TOMBSTONE naming what was cleared, and the poller
 * honours it. This module is the pure half — the rule itself — so it can be
 * tested without Redis. The read/write half is called-override.server.ts.
 *
 * THE TOMBSTONE IS NOT A MUTE BUTTON. It suppresses exactly one call: the
 * (session, calledAt) pair that was on screen when someone pressed Clear. The
 * moment staff genuinely call that heat again, Pandora re-stamps `calledAt`, the
 * stamp is newer than the one we buried, and the heat comes back on its own —
 * which is the other half of what was asked for ("should have ability to delete
 * session from system so it can be called again"). Placing a session back onto
 * the slot by hand lifts it too.
 */

/** What the desk cleared, and when. Stored per track. */
export interface ClearedCall {
  /** The Pandora session id that was cleared. */
  sessionId: number;
  /** The `calledAt` stamp that was on the cleared record, if it had one. */
  calledAt: string | null;
  /** When the clear happened — for the audit trail, not for the rule. */
  atMs: number;
}

/** Milliseconds for a Pandora `calledAt`, or null if it cannot be read. */
function stampMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Should this incoming call be swallowed because the desk cleared it?
 *
 * Deliberately conservative: when the stamps cannot be compared, the clear
 * wins. A clear that half-works is the bug this exists to fix, and the cost of
 * being wrong in this direction is one press of "→ check-in" to put it back —
 * against a board that ignores staff for twenty minutes in the other.
 */
export function callIsSuppressed(
  cleared: ClearedCall | null | undefined,
  incoming: { sessionId: number; calledAt?: string | null } | null | undefined,
): boolean {
  if (!cleared || !incoming) return false;
  // A different heat is a different fact — never suppressed by an older clear.
  if (Number(cleared.sessionId) !== Number(incoming.sessionId)) return false;

  const buried = stampMs(cleared.calledAt);
  const arriving = stampMs(incoming.calledAt);

  // Nothing to compare against: the record we buried carried no usable stamp,
  // so treat any sighting of that session as the one we cleared.
  if (buried == null || arriving == null) return true;

  // A NEWER stamp means staff called it again. That outranks the clear.
  return arriving <= buried;
}
