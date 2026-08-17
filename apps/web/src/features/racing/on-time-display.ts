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
 * ── THE TWO AUDIENCES WANT DIFFERENT THINGS ─────────────────────────────────
 *
 * GUESTS want to know WHEN TO BE AT THE DESK. That is the printed slot, and the
 * slot is a CHECK-IN time (owner 2026-08-17: "shouldn't say race, it should be
 * check in time"). This matters more than it looks: the flag drops a median 16
 * minutes after the slot, so a chip reading "Racing ~7:40" would send a guest to
 * the desk sixteen minutes after check-in had closed. The check-in time is also
 * the one number here that does NOT drift — measured against the slot, last
 * check-in ran a median 1.6 min EARLY with a 3.9 min spread, the tightest span
 * in the whole set — so it is stated plainly, not predicted.
 *
 * TVs want a VERDICT: "On Time", or "+14 late" (owner 2026-08-17). Computed from
 * OUR call metric, so unlike the service it replaced, a green board is green
 * because we actually called on time rather than because a 30-minute grace made
 * it impossible to be late.
 *
 * NOBODY gets the raw flag offset presented as a delay. It is ~17 minutes on a
 * flawless night; calling that "17 minutes late" is how we ended up scoring
 * ourselves 4% on-time while actually hitting check-in 90% of the time.
 */
import type { OnTimeSnapshot, TrackOnTime } from "./on-time";
import { LATE_CALL_MIN } from "./on-time";

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
  /**
   * WHEN TO BE AT THE DESK — the heat's printed slot, stated as printed.
   *
   * Not predicted and not adjusted: check-in lands on the slot (median 1.6 min
   * early, 3.9 min spread) and shifting it would be inventing drift that the
   * data says is not there. Null when no heat is checking in on this track.
   */
  checkInAtMs: number | null;
  /**
   * The TV verdict, in minutes. `null` = "On Time"; a number = "+N late".
   *
   * Driven by the MEDIAN call delay rather than the worst recent call, so a
   * single bad call cannot flip a wall to red and back between heats — that is
   * the whole reason the median is taken over three heats (on-time.ts).
   */
  lateByMin: number | null;
  /** Calls that went out after the slot, worst first. The staff detail line. */
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
 * The check-in time passes through untouched — it is the slot, and the slot is
 * what the guest was told. Only the verdict is derived.
 */
export function trackDisplay(
  snapshot: OnTimeSnapshot | null,
  track: string,
  scheduledStartMs: number | null,
): TrackDisplay {
  const t = snapshot?.tracks?.[track] ?? null;
  const thin = !snapshot || snapshot.slotCoverage.withSlot < MIN_SLOT_COVERAGE;

  // The check-in time survives a thin night: it is the printed slot, which is
  // true whether or not we have measured anything. Only the VERDICT needs data.
  const checkInAtMs = scheduledStartMs;

  if (!t || thin) {
    return {
      tone: "unknown",
      checkInAtMs,
      lateByMin: null,
      lateCalls: [],
      callDelayMin: null,
      callDelayN: 0,
      insufficientData: true,
    };
  }

  const behind = t.callDelayMin !== null && t.callDelayMin > LATE_CALL_MIN;

  return {
    // Amber is reserved for a track whose CALLS are running late — the one thing
    // here that is both our fault and fixable. A long pipeline is not amber.
    tone: t.status === "behind" ? "warn" : t.status === "unknown" ? "unknown" : "ok",
    checkInAtMs,
    // Rounded here rather than at each surface, so the wall and the tablet
    // opposite it can never disagree by a minute.
    lateByMin: behind ? Math.round(t.callDelayMin as number) : null,
    lateCalls: t.lateCalls,
    callDelayMin: t.callDelayMin,
    callDelayN: t.callDelayN,
    insufficientData: false,
  };
}

/**
 * The TV verdict as a display string: "On Time", "+14 late", or null.
 *
 * Null when we have not measured enough of tonight to stand behind either — a
 * wall must go quiet rather than claim "On Time" off two heats. Lives here so
 * every TV in the building phrases it identically.
 */
export function verdictLabel(d: TrackDisplay): string | null {
  if (d.insufficientData) return null;
  return d.lateByMin === null ? "On Time" : `+${d.lateByMin} late`;
}
