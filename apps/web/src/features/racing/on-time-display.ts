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
import { DEFAULT_RACE_BY_ALLOWANCE_MIN } from "./wait-times";

/**
 * How a surface should colour itself.
 *
 * "ok" is the ordinary state and must stay visually quiet — if the ordinary
 * ~17-minute pipeline lit an amber, every screen on the property would be amber
 * every night and the colour would stop meaning anything.
 *
 * THERE IS NO "unknown" TONE. Owner 2026-08-17: "if no data or outside of
 * business hours just mark tracks as on-time." A grey or blank board reads as
 * broken to a guest and to staff, and every screen in the building shows this —
 * so silence is the wrong default even though it is the more literal one. See
 * the default-green note on `trackDisplay`.
 */
export type OnTimeTone = "ok" | "warn";

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
  /**
   * True when we have not measured enough of tonight to have an opinion.
   *
   * The verdict still reads "On Time" in this state, by decision — see the
   * default-green note on `trackDisplay`. This flag exists so a STAFF surface can
   * add the reason underneath ("Not enough of tonight measured yet") while the
   * guest-facing headline stays green. Do not use it to blank a board.
   */
  insufficientData: boolean;
  /**
   * Heats ran today and then the feed went quiet — a suspected outage.
   *
   * STAFF SURFACES ONLY, and never the verdict or the tone. Default-green means a
   * dead pipe and a finished night look identical to a guest; this is how the one
   * board with a marshal standing in front of it can tell them apart. A guest
   * cannot act on our data pipe, so guest walls stay green regardless.
   */
  feedStale: boolean;
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
 *
 * ── DEFAULT GREEN ───────────────────────────────────────────────────────────
 *
 * Owner 2026-08-17: "if no data or outside of business hours just mark tracks as
 * on-time." So an absent snapshot, a track that has run nothing, and a night too
 * thin to score all read "On Time" rather than going quiet.
 *
 * BOTH CASES THE OWNER NAMED LAND HERE WITHOUT AN HOURS TABLE, which is why
 * there is no opening-times constant to keep in sync with reality:
 *   - before opening, or on a dark day, no heats exist at all ⇒ no track entry;
 *   - after the last heat, every call has aged out of RECENT_CALL_MS ⇒ no median.
 * Both are indistinguishable from "nothing is wrong", which is what green means.
 *
 * THE COST, STATED PLAINLY: a genuine outage mid-evening — the bridge down, Neon
 * unreachable — is also indistinguishable from a quiet night, so a board would
 * read "On Time" while the track ran twenty minutes behind. That is the accepted
 * trade for never showing a blank board. `insufficientData` is how a staff
 * surface says so underneath; it is deliberately NOT allowed to blank anything.
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
      // Green, not grey — nothing is known to be wrong. See the note above.
      tone: "ok",
      checkInAtMs,
      lateByMin: null,
      lateCalls: [],
      callDelayMin: null,
      callDelayN: 0,
      insufficientData: true,
      // No track entry means no heats ran, which is a closed building rather
      // than a broken pipe.
      feedStale: t?.feedStale ?? false,
    };
  }

  const behind = t.callDelayMin !== null && t.callDelayMin > LATE_CALL_MIN;

  return {
    // Amber is reserved for a track whose CALLS are running late — the one thing
    // here that is both our fault and fixable. A long pipeline is not amber, and
    // neither is a track we simply have no median for yet.
    tone: t.status === "behind" ? "warn" : "ok",
    checkInAtMs,
    // Rounded here rather than at each surface, so the wall and the tablet
    // opposite it can never disagree by a minute.
    lateByMin: behind ? Math.round(t.callDelayMin as number) : null,
    lateCalls: t.lateCalls,
    callDelayMin: t.callDelayMin,
    callDelayN: t.callDelayN,
    insufficientData: false,
    feedStale: t.feedStale,
  };
}

/**
 * HOW LONG TO ALLOW between karting check-in and the green flag, minutes.
 *
 * Owner 2026-08-17: "shouldn't the heats coming up take account of what has
 * happened last hour?" They do — the cascade lives in wait-times.ts
 * (`raceByAllowance`), which walks last hour → today → last 7 days → 30 and takes
 * the first window with enough heats to mean something. This is just the reader.
 *
 * ALWAYS AN ESTIMATE, and the caller must say so — every surface renders it
 * behind an "Est." (owner: "make sure we put est."). It moves through the night
 * by design.
 */
export function raceByAllowanceMin(snapshot: OnTimeSnapshot | null, track: string): number {
  return snapshot?.tracks?.[track]?.raceByMin ?? DEFAULT_RACE_BY_ALLOWANCE_MIN;
}

/**
 * When to tell a guest they will be racing BY, given their heat's check-in slot.
 *
 * Rounded UP to the next 5 minutes, deliberately: this is a bound, so rounding
 * down would make it wrong in the one direction that costs someone their grid
 * slot.
 */
export function raceByAtMs(
  checkInAtMs: number,
  snapshot: OnTimeSnapshot | null,
  track: string,
): number {
  const at = checkInAtMs + raceByAllowanceMin(snapshot, track) * 60_000;
  const five = 5 * 60_000;
  return Math.ceil(at / five) * five;
}

/**
 * The TV verdict as a display string: "On Time" or "+14 late".
 *
 * NEVER NULL. A board always has something to say (owner 2026-08-17), and the
 * default is green — see the default-green note on `trackDisplay`. Lives here so
 * every TV in the building phrases it identically.
 */
export function verdictLabel(d: TrackDisplay): string {
  return d.lateByMin === null ? "On Time" : `+${d.lateByMin} late`;
}
