/**
 * WHAT EACH SURFACE SHOWS. One derivation, six screens.
 *
 * The home page, the racing page, both confirmation flows, every e-ticket, the
 * kiosk race hub and the signage status bar all answer "are we on time" — in
 * wildly different type sizes and two languages. What they must NOT do is answer
 * it differently, which is exactly what happens when each one reaches into the
 * raw snapshot and applies its own thresholds (see tasks/lessons.md, "extracted
 * component misses later fixes").
 *
 * So this module decides, and the surfaces only render. NO JSX and NO STRINGS
 * beyond the tone enum — the kiosk needs every guest-facing word in English AND
 * Spanish, so the words live with the components that have a translator.
 *
 * ── THE TWO AUDIENCES WANT DIFFERENT NUMBERS ────────────────────────────────
 *
 * GUESTS want a time: "your heat goes at ~7:42". Built from the printed slot
 * plus the track's live flag offset — back-tested at 86% within 5 minutes for
 * the next heat (on-time.ts).
 *
 * STAFF want an exception: "heat 31 was called 14 minutes late". The median call
 * delay is ~0 essentially always (it was 0.2 min on both tracks on 2026-08-16),
 * so a staff board showing the AVERAGE would be as permanently green — and as
 * useless — as the outside service it replaced. The signal is the outliers.
 *
 * NEITHER gets the raw flag offset presented as a delay. It is ~17 minutes on a
 * flawless night; calling that "17 minutes late" is how we ended up scoring
 * ourselves 4% on-time while actually hitting check-in 90% of the time.
 */
import { predictStartMs, type OnTimeSnapshot, type TrackOnTime } from "./on-time";

/**
 * How a surface should colour itself.
 *
 * "ok" is the ordinary state and must stay visually quiet — if the ordinary
 * ~17-minute pipeline lit an amber, every screen on the property would be amber
 * every night and the colour would stop meaning anything.
 */
export type OnTimeTone = "ok" | "warn" | "unknown";

export interface TrackDisplay {
  tone: OnTimeTone;
  /** When the heat now checking in will actually go green. Null when we have no
   *  offset yet, no slot, or nothing is checking in — show the printed time. */
  predictedStartMs: number | null;
  /** Trust in that prediction, by horizon. "low" ⇒ a surface should soften to a
   *  range, or say nothing, rather than state a minute it will miss by ten. */
  confidence: "high" | "fair" | "low" | null;
  /** Calls that went out after the slot, worst first. THE staff signal. */
  lateCalls: TrackOnTime["lateCalls"];
  /** Median minutes past the policy call time, and its sample size. Staff only —
   *  a guest has no use for it and it is ~0 almost always. */
  callDelayMin: number | null;
  callDelayN: number;
  /** True when today's data is too thin to say anything. Surfaces must fall back
   *  to the printed schedule, never to a confident "On Time". */
  insufficientData: boolean;
}

/**
 * Below this many heats carrying a slot, we do not have a night — we have a
 * handful of rows. Matters most on the deploy day itself, when the morning ran
 * before the column existed and every one of those heats is permanently
 * slot-less (race-timings-db.ts).
 */
export const MIN_SLOT_COVERAGE = 3;

/**
 * Fold one track's snapshot into what to render.
 *
 * `scheduledStartMs` is the slot of the heat currently checking in on this
 * track — from races-current, which is where every surface already gets it.
 *
 * "NOW" IS THE SNAPSHOT'S OWN `atMs`, deliberately, not `Date.now()`. Two
 * reasons, and the second is the load-bearing one:
 *
 *  1. The offset and the clock then come from the same read, so a confidence
 *     bucket can never be computed against a moment the offset did not know.
 *  2. `Date.now()` inside a component body is an impure render (react-hooks
 *     /purity, which is a pre-push gate here) — every surface calling this
 *     would have had to thread a ticking clock down to it. The snapshot is at
 *     most a few seconds old (an 8s server cache plus the poll), and the only
 *     thing `now` feeds is a 15/30-minute horizon bucket, so the precision is
 *     far beyond sufficient.
 */
export function trackDisplay(
  snapshot: OnTimeSnapshot | null,
  track: string,
  scheduledStartMs: number | null,
): TrackDisplay {
  const t = snapshot?.tracks?.[track] ?? null;
  const thin = !snapshot || snapshot.slotCoverage.withSlot < MIN_SLOT_COVERAGE;

  if (!t || thin) {
    return {
      tone: "unknown",
      predictedStartMs: null,
      confidence: null,
      lateCalls: [],
      callDelayMin: null,
      callDelayN: 0,
      insufficientData: true,
    };
  }

  const predicted = predictStartMs(scheduledStartMs, t.flagOffsetMin, snapshot.atMs);

  return {
    // Amber is reserved for a track whose CALLS are running late — the one thing
    // here that is both our fault and fixable. A long pipeline is not amber.
    tone: t.status === "behind" ? "warn" : t.status === "unknown" ? "unknown" : "ok",
    predictedStartMs: predicted?.atMs ?? null,
    confidence: predicted?.confidence ?? null,
    lateCalls: t.lateCalls,
    callDelayMin: t.callDelayMin,
    callDelayN: t.callDelayN,
    insufficientData: false,
  };
}

/**
 * Round a predicted time to the nearest 5 minutes.
 *
 * A prediction carrying ±3-6 minutes of real error should not be printed to the
 * minute — "7:42" claims a precision the back-test does not support, and a guest
 * reads it as a promise. "~7:40" is the same information, honestly stated.
 */
export function roundPredictedMs(atMs: number): number {
  const five = 5 * 60_000;
  return Math.round(atMs / five) * five;
}

/** Should a surface state a predicted time at all? "low" confidence at the far
 *  end of the night is where the back-test drops under half inside 5 minutes. */
export function shouldShowPrediction(d: TrackDisplay): boolean {
  return d.predictedStartMs !== null && d.confidence !== "low";
}
