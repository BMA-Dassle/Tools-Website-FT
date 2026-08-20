"use client";

/**
 * Reload the page as soon as the origin answers — and not one moment before.
 *
 * The thin React half of reload-gate.ts; read the block comment there for why a
 * TV must never navigate into an outage. Every reload on a wall panel goes
 * through this hook, so the next reason to reload one inherits the protection
 * instead of having to remember it.
 *
 * `armed` is a LATCH held by the caller, not an event. Disarming (a briefing
 * starts, a check-in opens) cancels the wait and re-arming starts it again, which
 * is the same "held, not dropped" behaviour the reload conditions already had.
 *
 * Returns true while a wanted reload is being held because the network is down,
 * so `?debug=1` can say so at the wall. A held reload and a screen with nothing
 * to do look identical from the front, and that is precisely how the last one
 * went unnoticed for a day.
 */
import { useEffect, useState } from "react";
import { networkReachableOffOrigin, originReachable, startGatedReload } from "./reload-gate";

/**
 * `escapeWedge` lets this gate break a HELD reload when a second hostname proves
 * the network is fine and only this page's connection is dead — read the
 * wedge-escape note in reload-gate.ts before turning it on anywhere new. It is
 * off by default because it is the one path that navigates without our own
 * origin having answered, so it belongs only to callers whose reload is already
 * rate-limited.
 */
export function useGatedReload(armed: boolean, escapeWedge = false): boolean {
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const handle = startGatedReload({
      probe: () => originReachable(),
      reload: () => window.location.reload(),
      // Called from the gate's own callback, never synchronously in this effect
      // body — a setState there cascades renders on a page that runs for weeks.
      onBlocked: setBlocked,
      ...(escapeWedge ? { offOriginProbe: () => networkReachableOffOrigin() } : {}),
    });
    return () => handle.cancel();
  }, [armed, escapeWedge]);

  // DERIVED, not reset. Clearing the flag when the caller disarms would mean a
  // setState in the effect body; anding with `armed` says the same thing with no
  // extra render, and a disarmed gate is by definition holding nothing.
  return armed && blocked;
}
