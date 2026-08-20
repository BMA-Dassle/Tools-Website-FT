"use client";

/**
 * "Updated 10:54:07 PM" — the one thing on the scores wall that proves the
 * scores wall is awake.
 *
 * WHY A TIMESTAMP AND NOT A PULSING DOT. This canvas forbids looping motion
 * outright (see the note at the top of SceneRaceResults, and the 24/7 rulebook
 * in app/tv/tv.css): a flash would need a beat registered in
 * TV_MOTION_PERIODS_MS, and guests read this board standing still. A pulsing
 * dot would also be the WRONG instrument even if it were allowed — every
 * moving pixel on this surface is a CSS animation, and CSS animations run on
 * the compositor, so a dot would keep pulsing happily over a main thread that
 * had died. It would prove the GPU is alive, which nobody was asking about.
 *
 * An advancing timestamp is not a flash, needs no beat, and cannot lie in
 * either direction:
 *
 *   - THE POLL LANE WEDGES, renderer fine → the stamp freezes where it stopped
 *     and, past the window, says so in amber.
 *   - THE RENDERER DIES → the stamp freezes too, and a clock stuck twenty
 *     minutes behind the room is the only signal that is even possible in that
 *     state. No React means no amber; the wrong time IS the message.
 *   - NOTHING IS WRONG, it is just a quiet 13-minute heat → the seconds keep
 *     moving, and the question is answered in one glance without a laptop,
 *     which is the entire point.
 *
 * ITS OWN CLOCK, NOT THE DIRECTOR'S TICK. The scene above re-renders four times
 * a second already, so this could have ridden that for free. It does not, for
 * the same reason the ?debug=1 overlay does not: the one readout whose job is
 * to keep moving when everything else has stopped must not depend on anything
 * else still moving. One 1s interval on a leaf that renders a single line.
 */
import { useEffect, useState } from "react";
import { useFeedHealth } from "../feed-health";
import { feedLiveness, livenessLine } from "../liveness";

/** The venue's established attention amber — the same one the check-in rail and
 *  the desk board escalate in, so a marshal reads one language across the
 *  building. Not a new colour, and deliberately not GOLD: gold is P1's colour
 *  on this very canvas. */
const STALE = "#f0b341";

export function LiveStamp() {
  const health = useFeedHealth();

  // Raw Date.now(), matching the raw stamps in health — see liveness.ts on why
  // the corrected shared clock would put the whole offset into the answer.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(iv);
  }, []);

  // The sentence itself is decided in liveness.ts so a test can pin it without
  // a renderer; this component only chooses how it is painted.
  const line = livenessLine(feedLiveness({ ...health, nowMs }));
  if (!line) return null;

  // Healthy: the colour is INHERITED from the footer's right slot, which is
  // already DIM — importing the palette would make this module and
  // results-chrome import each other, and the slot's own colour is the one that
  // should win anyway.
  return (
    <span style={line.stale ? { color: STALE, fontWeight: 700 } : undefined}>{line.text}</span>
  );
}
