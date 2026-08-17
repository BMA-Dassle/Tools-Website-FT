/**
 * ARE WE ON TIME? Computed from our own data. PURE — records in, numbers out.
 *
 * We used to buy this from tools-track-status.vercel.app. Owner 2026-08-17: "I'm
 * thinking we control ourselves." We can, and could always have: the venue
 * broadcast carries `ScheduledStart` on every race record (103/103 on Saturday
 * 2026-08-16, zero missing) and we simply were not parsing it.
 *
 * ── THE THING EVERY EARLIER VERSION OF THIS GOT WRONG ────────────────────────
 *
 * THE PRINTED SLOT IS A CHECK-IN TIME, NOT A GREEN-FLAG TIME. Joining the venue's
 * slots to the same night's briefing log, against the slot:
 *
 *     called            median  −4.8 min   (we call BEFORE the slot)
 *     first check-in    median  −3.4 min
 *     last check-in     median  −1.6 min   ← the group is in, essentially ON the slot
 *     sent to room      median  +1.2 min
 *     GREEN FLAG        median  +16.1 min
 *
 * So `actualStart − scheduledStart` is not lateness. It is the briefing pipeline —
 * call, check in, walk, film, helmets, grid — and it is ~17 minutes by design.
 * Scoring ourselves on it produced "0 of 54 Blue heats on time"; scoring at
 * check-in produced 90%. Same night, same data. Everything below therefore
 * measures LATENESS AT THE CALL and treats the flag offset purely as a
 * PREDICTOR, never as a delay.
 *
 * (The outside service papered over exactly this mismatch with a 30-minute grace,
 * which made 99 of 100 heats read "On Time" — green by construction, and so
 * carrying no information at all. Replacing one always-green number with another
 * would be no gain, which is why the display leads on late-call EXCEPTIONS.)
 *
 * ── WHY MEDIAN, WHY THREE ───────────────────────────────────────────────────
 *
 * Call times cluster hard: 85 of 99 land in a two-minute band around the policy,
 * with a thin tail out to +21. That tail drags the MEAN to 1.4 while the MEDIAN
 * sits at 0.2 — one bad call would read as a track-wide problem. Median, always.
 *
 * Window size was measured, not guessed. Jitter of the displayed number between
 * consecutive heats, against how fast a real slip surfaces:
 *
 *     last 1 heat    1.83 min jitter    catches a +10 slip in 1 heat
 *     last 3 heats   0.67 min jitter    catches it in 2 heats   ← the knee
 *     last 8 heats   0.13 min jitter    catches it in 4 heats
 *
 * Past 3-4 you buy half a minute of steadiness and pay two extra heats (~25 min)
 * of blindness. Three it is.
 *
 * PER TRACK, never combined. Blue and Red are separately staffed and separately
 * scheduled. They happened to agree on the median (0.2 / 0.2) on 2026-08-16 but
 * differed in the tail (p90 3.5 vs 2.0), and a combined number would describe a
 * night neither track had.
 */

/** The desk's working policy: call the heat this many minutes BEFORE its slot.
 *
 *  INFERRED FROM BEHAVIOUR, not from a written rule — 85 of 99 calls on
 *  2026-08-16 landed in the −6/−4 buckets. If the desk's actual instruction is a
 *  different number this constant is the one place to change it, and every
 *  figure below moves with it. */
export const CALL_LEAD_MIN = 5;

/** A call is LATE when it goes out after the time we told the guest to be here —
 *  i.e. later than the slot itself, which is `CALL_LEAD_MIN` past target. A clean
 *  line to explain and a genuinely rare event: 8 of 99 on 2026-08-16. */
export const LATE_CALL_MIN = CALL_LEAD_MIN;

/** Heats in the rolling median. See the header — measured, not guessed. */
export const CALL_WINDOW_HEATS = 3;

/** How long a called heat still counts toward "right now". Three heats at a
 *  12-minute grid is ~36 min; this covers it with room for a slow stretch
 *  without letting the lunch shift describe the evening. */
export const RECENT_CALL_MS = 75 * 60_000;

/**
 * Beyond this, an offset is a data problem rather than a delay.
 *
 * Mega's late-night slots are nominal rather than a real grid — its three heats
 * on 2026-08-16 read 47-56 minutes "late" against slots nobody was running to.
 * Predicting from an offset like that would tell a guest their race is an hour
 * out on the strength of a scheduling artefact, so we say "unknown" instead.
 */
export const MAX_PLAUSIBLE_OFFSET_MIN = 45;

/**
 * Completed heats needed before today's check-in → race span is worth quoting.
 *
 * Below this, a p90 is just "the slowest of a handful" and would swing the
 * estimate on every card in a grid that shows heats hours ahead. Six covers
 * roughly the first hour of a track's night, after which the figure settles.
 */
export const MIN_DAY_OFFSET_HEATS = 6;

/**
 * The fallback allowance, minutes, when today has not run enough heats yet.
 *
 * Measured, bounded, and deliberately an ALLOWANCE rather than an estimate — see
 * the duration note in lib/karting-checkin-copy.ts for the two samples behind it
 * and, more importantly, for the caveats (it was exceeded once in 100 heats, and
 * only one weekend day is in the sample).
 */
export const DEFAULT_RACE_BY_ALLOWANCE_MIN = 30;

/**
 * A track that has run heats today but has reported NOTHING for this long is a
 * suspected outage rather than a quiet night.
 *
 * This exists because green is the default (owner 2026-08-17: "if no data or
 * outside of business hours just mark tracks as on-time"), and that default has
 * one hole: a dead bridge and a finished night look identical, so a board would
 * read "On Time" while a track ran twenty minutes behind. The distinguishing fact
 * is that heats ALREADY RAN today — an empty night never had any.
 *
 * 40 minutes is a bit over three heats on a 12-minute grid, so an ordinary gap
 * (a long turnaround, a stoppage, a track reset) never trips it.
 *
 * STAFF SURFACES ONLY. This must not turn a guest wall amber — a guest cannot
 * act on our data pipe, and the owner's decision was explicitly that guest boards
 * stay green.
 */
export const STALE_FEED_MS = 40 * 60_000;

/** One heat, as much as we know about it. Any field may be null — half of these
 *  only exist for heats that got far enough to have them. */
export interface OnTimeHeat {
  sessionId: string;
  track: string | null;
  heatNumber: number | null;
  /** The venue's own ScheduledStart. Null for anything before 2026-08-17. */
  scheduledStartMs: number | null;
  /** The green flag. Null until the heat actually goes. */
  actualStartMs: number | null;
  /** When the desk called the session. Null if it was never called, or if the
   *  call's Redis record aged out before the send wrote it down. */
  calledAtMs: number | null;
}

/** A call that went out after the slot. The exception the boards actually show. */
export interface LateCall {
  sessionId: string;
  heatNumber: number | null;
  /** Minutes past the policy call time. Always > LATE_CALL_MIN. */
  delayMin: number;
  calledAtMs: number;
}

export type OnTimeStatus = "on-time" | "behind" | "unknown";

/** One track's answer to "are we on time, right now". */
export interface TrackOnTime {
  track: string;
  status: OnTimeStatus;
  /**
   * Median minutes past the policy call time over the last CALL_WINDOW_HEATS
   * called heats. Negative = calling early, which is the normal state.
   * Null when nothing in the window carried both a slot and a call.
   */
  callDelayMin: number | null;
  /** How many heats that median was taken over. A board must show this, or a
   *  single-sample median reads with the same confidence as a full window. */
  callDelayN: number;
  /** Late calls still inside the rolling window, worst first. THE SIGNAL. */
  lateCalls: LateCall[];
  /**
   * The last completed heat's flag offset (`actualStart − scheduledStart`), in
   * minutes — the briefing pipeline as it is running right now.
   *
   * NOT a delay — it is ~17 minutes on a perfectly on-time night. Carried on the
   * payload as the honest description of how long the pipeline is running; see
   * the note at the foot of this file for what it can and cannot be used for.
   */
  flagOffsetMin: number | null;
  /** Which heat that offset came from, so a board can say how stale it is. */
  flagOffsetHeatNumber: number | null;
  flagOffsetAtMs: number | null;
  /**
   * TODAY'S CHECK-IN → RACE SPAN, over every heat on this track that has already
   * gone green. Owner 2026-08-17: "the race by can get more accurate using the
   * check in to race estimate time for the day."
   *
   * `p90` is the one a "racing by" bound should use — it is a planning allowance,
   * so the typical case (the median) would be beaten by nearly half the field and
   * the max is one bad heat away from nonsense. The median rides along because it
   * is the honest answer to "how long does this usually take".
   *
   * Null until `dayOffsetN` clears MIN_DAY_OFFSET_HEATS: a p90 over three heats
   * is just the slowest of three, and a booking grid showing heats four hours out
   * must not swing on that.
   */
  dayOffsetMedianMin: number | null;
  dayOffsetP90Min: number | null;
  /** How many completed heats the two figures above were taken over. */
  dayOffsetN: number;
  /**
   * Heats ran today, but nothing has reported for STALE_FEED_MS — a suspected
   * dead feed rather than a finished night.
   *
   * The ONE hole in default-green, surfaced for staff only. False on a night that
   * never started, because an empty night has no heats to have gone quiet.
   */
  feedStale: boolean;
  /** When this track last told us anything (a call or a green flag). */
  lastSignalAtMs: number | null;
}

/**
 * One read of the whole property. Lives here rather than in on-time.server.ts so
 * client components can import the TYPE without dragging `server-only` in.
 */
export interface OnTimeSnapshot {
  businessDay: string;
  /** Keyed by track — "blue" | "red" | "mega", only those that ran. */
  tracks: Record<string, TrackOnTime>;
  /** When this was computed. Boards show staleness from it. */
  atMs: number;
  /**
   * Heats that carried a slot, out of all heats today.
   *
   * SHOWN, NOT SWALLOWED. Every race before 2026-08-17 has a null slot and can
   * never be backfilled, so a day straddling the deploy has partial coverage. A
   * surface reporting "on time" off two heats out of ninety would be lying by
   * omission.
   */
  slotCoverage: { withSlot: number; total: number };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Median of a numeric list. Empty in, null out — never a confident 0. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Minutes past the policy call time. Negative = called early (the normal state).
 *
 * Null unless BOTH stamps are real: a heat nobody called and a heat with no slot
 * are different facts, and neither is "on time".
 */
export function callDelayMin(heat: OnTimeHeat): number | null {
  if (heat.calledAtMs == null || heat.scheduledStartMs == null) return null;
  if (!Number.isFinite(heat.calledAtMs) || !Number.isFinite(heat.scheduledStartMs)) return null;
  const slotDeltaMin = (heat.calledAtMs - heat.scheduledStartMs) / 60_000;
  return round1(slotDeltaMin + CALL_LEAD_MIN);
}

/**
 * The flag offset — how far behind its slot the green flag actually dropped.
 *
 * Named `offset`, never `delay`, on purpose: on a night where everything went
 * right this is ~17 minutes. Anything absurd (a stale id paired with the wrong
 * race, Mega's nominal slots) is dropped rather than published.
 */
export function flagOffsetMin(heat: OnTimeHeat): number | null {
  if (heat.actualStartMs == null || heat.scheduledStartMs == null) return null;
  if (!Number.isFinite(heat.actualStartMs) || !Number.isFinite(heat.scheduledStartMs)) return null;
  const mins = (heat.actualStartMs - heat.scheduledStartMs) / 60_000;
  if (mins < -MAX_PLAUSIBLE_OFFSET_MIN || mins > MAX_PLAUSIBLE_OFFSET_MIN) return null;
  return round1(mins);
}

/**
 * Fold one track's night into what a board should say right now.
 *
 * `heats` may arrive in any order and may contain other tracks; both are handled
 * here so callers can hand over the whole day.
 */
export function trackOnTime(track: string, heats: OnTimeHeat[], nowMs: number): TrackOnTime {
  const mine = heats
    .filter((h) => h.track === track)
    .sort((a, b) => (a.scheduledStartMs ?? 0) - (b.scheduledStartMs ?? 0));

  // ── the call metric: last N *called* heats, inside the recent window ──
  const called = mine
    .filter((h) => h.calledAtMs != null && nowMs - h.calledAtMs <= RECENT_CALL_MS)
    .sort((a, b) => (a.calledAtMs ?? 0) - (b.calledAtMs ?? 0));

  const window = called.slice(-CALL_WINDOW_HEATS);
  const delays = window.map((h) => callDelayMin(h)).filter((d): d is number => d !== null);
  const med = median(delays);

  // Late calls across the WHOLE recent window, not just the median's three —
  // a bad call four heats back is still the thing the desk wants to see.
  const lateCalls: LateCall[] = called
    .map((h) => ({ heat: h, delay: callDelayMin(h) }))
    .filter(
      (x): x is { heat: OnTimeHeat; delay: number } => x.delay !== null && x.delay > LATE_CALL_MIN,
    )
    .map(({ heat, delay }) => ({
      sessionId: heat.sessionId,
      heatNumber: heat.heatNumber,
      delayMin: delay,
      calledAtMs: heat.calledAtMs as number,
    }))
    .sort((a, b) => b.delayMin - a.delayMin);

  // ── the predictor: the most recent heat that actually went green ──
  const started = mine
    .filter((h) => h.actualStartMs != null && flagOffsetMin(h) !== null)
    .sort((a, b) => (a.actualStartMs ?? 0) - (b.actualStartMs ?? 0));
  const last = started.length ? started[started.length - 1] : null;

  // ── today's check-in → race span, across the whole night so far ──
  // Every completed heat, not a rolling window: a booking grid quotes heats
  // hours ahead, so it wants the day's shape rather than the last twenty minutes.
  const dayOffsets = started
    .map((h) => flagOffsetMin(h))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const enough = dayOffsets.length >= MIN_DAY_OFFSET_HEATS;

  // The most recent thing this track told us, of any kind — a call or a flag.
  // Both are pushes from a live pipe, so either one arriving means it is alive.
  const lastSignalAtMs = mine.reduce<number | null>((acc, h) => {
    const stamps = [h.calledAtMs, h.actualStartMs].filter(
      (v): v is number => v != null && Number.isFinite(v),
    );
    const newest = stamps.length ? Math.max(...stamps) : null;
    return newest != null && (acc == null || newest > acc) ? newest : acc;
  }, null);

  // A night that never started has nothing to have gone quiet — feedStale is
  // about a pipe that WAS delivering and stopped.
  const feedStale = lastSignalAtMs !== null && nowMs - lastSignalAtMs > STALE_FEED_MS;

  return {
    track,
    status: med === null ? "unknown" : med > LATE_CALL_MIN ? "behind" : "on-time",
    callDelayMin: med === null ? null : round1(med),
    callDelayN: delays.length,
    lateCalls,
    flagOffsetMin: last ? flagOffsetMin(last) : null,
    flagOffsetHeatNumber: last?.heatNumber ?? null,
    flagOffsetAtMs: last?.actualStartMs ?? null,
    dayOffsetMedianMin: enough ? round1(median(dayOffsets) as number) : null,
    dayOffsetP90Min: enough ? round1(percentile(dayOffsets, 90)) : null,
    dayOffsetN: dayOffsets.length,
    feedStale,
    lastSignalAtMs,
  };
}

/** Nearest-rank percentile of an already-sorted list. Small n by design here —
 *  a night is tens of heats, so there is nothing to gain from interpolating. */
function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

/** Every track present in the data, folded. */
export function onTimeByTrack(heats: OnTimeHeat[], nowMs: number): Record<string, TrackOnTime> {
  const tracks = new Set<string>();
  for (const h of heats) if (h.track) tracks.add(h.track);
  const out: Record<string, TrackOnTime> = {};
  for (const t of tracks) out[t] = trackOnTime(t, heats, nowMs);
  return out;
}

/*
 * A NOTE ON PREDICTING THE GREEN FLAG, so the next person does not re-derive it.
 *
 * `flagOffsetMin` above is enough to predict when a heat will actually go:
 * slot + the last completed heat's offset. Back-tested over 2026-08-16 (blue and
 * red, n≈95 per horizon):
 *
 *     ~12 min out (next heat)   MAE 3.3 min   86% within 5 min
 *     ~24 min out               MAE 5.1       69% within 5
 *     ~36 min out               MAE 5.8       55% within 5,  87% within 10
 *     ~48 min out               MAE 6.7       47% within 5,  80% within 10
 *
 * Median-of-last-3 is WORSE than the single last heat (76% vs 87% within 5 min):
 * the offset drifts through the night, so recency beats smoothing — the opposite
 * of the call metric above, because it is a different question.
 *
 * NOTHING RENDERS THIS, deliberately. Guest surfaces show the CHECK-IN time,
 * because that is what the printed slot names and what a guest has to act on;
 * telling them a flag time would send them to a desk that closed sixteen minutes
 * earlier (owner 2026-08-17). The arithmetic is one line if a surface ever
 * genuinely needs it, and the numbers above are what it would be worth.
 */
