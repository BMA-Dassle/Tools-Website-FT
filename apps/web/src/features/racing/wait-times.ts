/**
 * HOW LONG A GROUP WAITS, AT EVERY STEP. PURE — records in, durations out.
 *
 * The owner's question (2026-08-12): "I'd like some wait times. Average time in
 * check-in area. Average time from session called to race. Average time from end
 * of briefing to race. Average overall experience, called to end of race… we
 * should plan on having data for each movement — called to room to briefing to
 * holding (this is where they go before the race starts), etc."
 *
 * So the night is modelled as ONE CHAIN OF MOVEMENTS, and every metric is a span
 * between two points on it:
 *
 *   checked in ─► CALLED ─► sent to room ─► film rolls ─► briefing ends ─►
 *   holding ─► race starts ─► race ends
 *
 * WHERE EACH POINT COMES FROM, and how much to trust it:
 *
 *   checked in     Pandora's per-racer `checkedIn` stamp, folded to first/last
 *                  at the send (briefing_events). FIRST AND LAST COLLAPSE for a
 *                  group checked in as one action — a zero spread there is real.
 *   called         the races-current record, stamped at the send because it ages
 *                  out ~20 min later.
 *   sent / film    the briefing log. Recorded, exact, and already insurance-grade.
 *   briefing ends  the log's own end: a stamped release if staff cleared the room,
 *                  otherwise film length + the helmet phase the TV is known to
 *                  hold. Derived, not guessed — the same arithmetic drives the wall.
 *   race start/end the venue timing broadcast's ActualStart / ActualEnd
 *                  (race_timings).
 *
 * HOLDING IS DERIVED, NOT PRESSED. There is no button for "released to holding"
 * and deliberately so: staff already resist presses, and briefing-end → race-start
 * measures exactly the same interval without asking anyone for anything. If that
 * number ever proves too fuzzy to act on, a press is the upgrade — but it should
 * have to earn its way in.
 *
 * A MISSING POINT DROPS THE SPAN, NEVER ZEROES IT. Half this data only exists for
 * heats sent after the capture shipped, and a group that was never briefed has no
 * briefing at all. An average that quietly counted those as 0 would read as "we
 * are fast" while measuring nothing, which is worse than an honest gap — so every
 * span is null unless BOTH its ends are real, and every average reports the `n`
 * it was computed from.
 *
 * IMPLAUSIBLE SPANS ARE DROPPED TOO. A session id that outlives its night, a room
 * nobody cleared, a catch-up dump pairing the wrong pieces: any of them can
 * produce a "wait" of six hours, and one of those in a mean makes the whole tile
 * a lie. Anything negative or beyond MAX_PLAUSIBLE_SPAN_MS is discarded and
 * COUNTED, so the board can say how much it threw away rather than hiding it.
 */

/** The two ends of one race, as the venue's own clock recorded them. */
export interface RaceWindow {
  sessionId: string;
  startedAtMs: number | null;
  endedAtMs: number | null;
  /**
   * The slot the heat was SOLD as — the venue's ScheduledStart, verified
   * 2026-08-17 to be identical to the minute to the time Pandora sold (113/113
   * sessions). Null for every race before 2026-08-17; there is no backfill.
   */
  scheduledStartMs?: number | null;
}

/** What the fold needs from a briefing record — a structural subset, so the
 *  metrics do not drag the whole log type (or its imports) around with them. */
export interface BriefingSpanSource {
  sessionId: string;
  track: string | null;
  heatNumber: number | null;
  raceType: string | null;
  sentAtMs: number;
  startedAtMs: number | null;
  endedAtMs: number | null;
  calledAtMs: number | null;
  checkinFirstAtMs: number | null;
  checkinLastAtMs: number | null;
  checkinIn: number | null;
  checkinTotal: number | null;
}

/**
 * Longer than this and it is not a wait, it is a data problem.
 *
 * Three hours covers the worst real night imaginable — a heat called into a long
 * delay, a group that sat through two films — and excludes the failure shapes
 * that produce five- and six-hour spans (a room nobody cleared, a stale id
 * paired with the wrong race).
 */
export const MAX_PLAUSIBLE_SPAN_MS = 3 * 3_600_000;

/** Every movement we can measure for one group, ms. Null = not measurable. */
export interface SessionWaits {
  sessionId: string;
  track: string | null;
  heatNumber: number | null;
  /**
   * WHEN THIS GROUP WENT TO THE ROOM — the clock a rolling window is cut on.
   *
   * "Are we running behind right now" is a question about the LAST HOUR, not
   * about the night, and a night's median is exactly the thing that hides a
   * shift going wrong at 9pm. Windowing needs one timestamp per group, and the
   * send is the right one: it is the moment the desk acted, it always exists
   * (every record has it), and it sits at the head of every span measured here.
   */
  atMs: number;
  raceType: string | null;
  /**
   * THE PRINTED SLOT → THE GREEN FLAG. The only span here a GUEST is ever shown.
   *
   * Both ends are machine stamps off the venue broadcast — no staff press, no
   * derivation — which is why this is the anchor for the kiosk's "Est. racing by"
   * rather than called→race. Going via the call would mean adding back a ~5 min
   * lead that is inferred from behaviour, never confirmed, and unknowable for a
   * heat that has not been called yet.
   *
   * NOT `calledToRaceEndMs`, which the wait-times panel labels "TOTAL EXPERIENCE"
   * — that one runs to the CHEQUERED flag and so carries the whole race (a ~9½
   * min median) inside it. Quoting it on a booking card would overstate by ten
   * minutes (owner 2026-08-17: "total experience includes the race though").
   */
  slotToRaceMs: number | null;
  /** First racer through the desk → sent to the briefing room. */
  checkinToRoomMs: number | null;
  /** How spread out the group's own arrivals were. 0 for a group check-in. */
  checkinSpreadMs: number | null;
  /** Called → sent to the room. The desk's own half of the wait. */
  calledToRoomMs: number | null;
  /** Sent to the room → the film actually rolling (the walk, plus any wait). */
  roomToFilmMs: number | null;
  /** Sent to the room → the flag drops. The number the desk can actually act on:
   *  everything between "I sent them" and "they are racing", in one span. */
  roomToRaceMs: number | null;
  /** Sent → left the room. The insurance log's own in-room time. */
  inRoomMs: number | null;
  /** HOLDING: left the briefing room → the flag drops. */
  briefingToRaceMs: number | null;
  /** Called → the flag drops. */
  calledToRaceMs: number | null;
  /** Called → chequered flag. The whole experience, end to end. */
  calledToRaceEndMs: number | null;
  /** The race itself. */
  raceMs: number | null;
  checkedIn: number | null;
  rosterTotal: number | null;
  /**
   * Metrics whose two ends BOTH existed and still produced an impossible span.
   *
   * Kept per session rather than recomputed from a second pass, because it is the
   * difference between "we never measured this" (a low `n`, ordinary) and "we
   * measured something impossible" (a bug, and one that would otherwise vanish
   * silently into a null).
   */
  implausible: WaitMetric[];
}

/** The metric keys an average can be taken over. */
export const WAIT_METRICS = [
  "slotToRaceMs",
  "checkinToRoomMs",
  "checkinSpreadMs",
  "calledToRoomMs",
  "roomToFilmMs",
  "roomToRaceMs",
  "inRoomMs",
  "briefingToRaceMs",
  "calledToRaceMs",
  "calledToRaceEndMs",
  "raceMs",
] as const;

export type WaitMetric = (typeof WAIT_METRICS)[number];

export interface WaitStat {
  /** Sessions that contributed a usable number. */
  n: number;
  avgMs: number | null;
  /** The number to READ. A single stuck group drags a mean and leaves the median
   *  alone, and on a busy night the typical wait is what staff can act on. */
  medianMs: number | null;
  /**
   * The number to PLAN AGAINST. A median is beaten by half the field, so it is
   * the wrong statistic for anything phrased as "by" — see raceByAllowance.
   * Nearest-rank, because a night is tens of heats and interpolating between two
   * of them would imply a precision the sample does not have.
   */
  p90Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
  /** Spans thrown out as implausible — surfaced, never swallowed. */
  discarded: number;
}

export type WaitSummary = Record<WaitMetric, WaitStat>;

/**
 * A span between two points, or null.
 *
 * Zero is a legitimate answer (a group check-in has no spread), so the guard is
 * on NEGATIVE, not falsy — and out-of-order stamps mean the pairing is wrong,
 * which is a discard rather than a number to explain away.
 */
function span(fromMs: number | null, toMs: number | null): number | null {
  if (fromMs == null || toMs == null) return null;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  const ms = toMs - fromMs;
  if (ms < 0 || ms > MAX_PLAUSIBLE_SPAN_MS) return null;
  return ms;
}

/**
 * One group's movements.
 *
 * `race` is that session's timing row, if the night got that far — a group still
 * in the briefing room simply has nulls from `briefingToRaceMs` onward.
 */
export function sessionWaits(
  briefing: BriefingSpanSource,
  race: RaceWindow | null | undefined,
): SessionWaits {
  const raceStartMs = race?.startedAtMs ?? null;
  const raceEndMs = race?.endedAtMs ?? null;
  const implausible: WaitMetric[] = [];

  /** Measure one span and remember it if it came out impossible. */
  const at = (metric: WaitMetric, fromMs: number | null, toMs: number | null): number | null => {
    const ms = span(fromMs, toMs);
    if (ms === null && fromMs != null && toMs != null) implausible.push(metric);
    return ms;
  };

  return {
    sessionId: briefing.sessionId,
    track: briefing.track,
    heatNumber: briefing.heatNumber,
    atMs: briefing.sentAtMs,
    raceType: briefing.raceType,
    // The slot rides on the RACE row, not the briefing — it is the venue's own
    // stamp for that session, and it is null for anything before 2026-08-17.
    slotToRaceMs: at("slotToRaceMs", race?.scheduledStartMs ?? null, raceStartMs),
    checkinToRoomMs: at("checkinToRoomMs", briefing.checkinFirstAtMs, briefing.sentAtMs),
    checkinSpreadMs: at("checkinSpreadMs", briefing.checkinFirstAtMs, briefing.checkinLastAtMs),
    calledToRoomMs: at("calledToRoomMs", briefing.calledAtMs, briefing.sentAtMs),
    roomToFilmMs: at("roomToFilmMs", briefing.sentAtMs, briefing.startedAtMs),
    roomToRaceMs: at("roomToRaceMs", briefing.sentAtMs, raceStartMs),
    inRoomMs: at("inRoomMs", briefing.sentAtMs, briefing.endedAtMs),
    briefingToRaceMs: at("briefingToRaceMs", briefing.endedAtMs, raceStartMs),
    calledToRaceMs: at("calledToRaceMs", briefing.calledAtMs, raceStartMs),
    calledToRaceEndMs: at("calledToRaceEndMs", briefing.calledAtMs, raceEndMs),
    raceMs: at("raceMs", raceStartMs, raceEndMs),
    checkedIn: briefing.checkinIn,
    rosterTotal: briefing.checkinTotal,
    implausible,
  };
}

/**
 * Every group's movements, joined to its race.
 *
 * ONE ROW PER BRIEFING, not per race: a Mega group briefed in both rooms is two
 * briefings and one race, and both rooms' waits are real. The race window is
 * looked up by session id, which is the same id space on both sides (verified
 * exact against live assignments — see race-finish.server.ts).
 */
export function waitsForDay(briefings: BriefingSpanSource[], races: RaceWindow[]): SessionWaits[] {
  const byId = new Map<string, RaceWindow>();
  for (const r of races) byId.set(r.sessionId, r);
  return briefings.map((b) => sessionWaits(b, byId.get(b.sessionId)));
}

/**
 * Only the groups sent since `fromMs` — the rolling window behind "last hour".
 *
 * A separate function rather than an argument to the summary, because the fold
 * and the window are different questions and a caller nearly always wants BOTH
 * over the same data: today's median is what "behind" is measured against.
 */
export function waitsSince(waits: SessionWaits[], fromMs: number): SessionWaits[] {
  return waits.filter((w) => Number.isFinite(w.atMs) && w.atMs >= fromMs);
}

/** The rolling window the desk reads as "right now". Long enough to hold a few
 *  heats on any track, short enough that a shift going wrong shows up in it. */
export const RECENT_WINDOW_MS = 60 * 60_000;

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Nearest-rank percentile of an already-sorted list. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/**
 * Average every metric across a set of groups.
 *
 * Empty in, and every stat is `n: 0` with null numbers — a board reading this
 * must show "—", never a confident 0:00 over no data at all.
 */
export function summariseWaits(waits: SessionWaits[]): WaitSummary {
  const out = {} as WaitSummary;
  for (const metric of WAIT_METRICS) {
    const values: number[] = [];
    let discarded = 0;
    for (const w of waits) {
      if (w.implausible.includes(metric)) discarded += 1;
      const v = w[metric];
      if (typeof v === "number" && Number.isFinite(v)) values.push(v);
    }
    values.sort((a, b) => a - b);
    const sum = values.reduce((acc, v) => acc + v, 0);
    out[metric] = {
      n: values.length,
      avgMs: values.length ? Math.round(sum / values.length) : null,
      medianMs: median(values),
      p90Ms: percentile(values, 90),
      minMs: values.length ? values[0] : null,
      maxMs: values.length ? values[values.length - 1] : null,
      discarded,
    };
  }
  return out;
}

/**
 * The same summary, split by TRACK — which is how the desk reads it.
 *
 * Blue and red run their own schedules with their own delays, so one combined
 * average describes a night neither track had. A Mega day is its own track key,
 * not a merge of the two, for the same reason.
 *
 * Every track that appears in the data gets a bucket; a track that ran nothing
 * simply is not there, rather than a row of confident zeros.
 */
export function summariseWaitsByTrack(waits: SessionWaits[]): Record<string, WaitSummary> {
  const byTrack = new Map<string, SessionWaits[]>();
  for (const w of waits) {
    const key = w.track ?? "unknown";
    const bucket = byTrack.get(key);
    if (bucket) bucket.push(w);
    else byTrack.set(key, [w]);
  }
  const out: Record<string, WaitSummary> = {};
  for (const [track, rows] of byTrack) out[track] = summariseWaits(rows);
  return out;
}

/* ── "Est. racing by": how long to allow from the printed slot ──────────── */

/**
 * Heats a window needs before its p90 is worth quoting to a guest.
 *
 * Owner 2026-08-17: "shouldn't the heats coming up take account of what has
 * happened last hour?" Yes — recency wins, and it is measured: predicting the
 * next heat from the last completed one scored MAE 3.3 min, while smoothing over
 * three was WORSE (76% vs 87% within 5 min). The offset drifts through a night.
 *
 * But the last hour is often two or four heats — the wait-times panel showed
 * `LAST HOUR · 2` on the night this was written — and a p90 over two heats is
 * just "the slower of two". Six is where the number stops swinging on one
 * turnaround.
 */
export const MIN_WINDOW_HEATS = 6;

/** The fallback when no window has enough heats (owner: "if no data for the day
 *  use 30 minutes"). Measured, bounded, and an ALLOWANCE — see the duration note
 *  in lib/karting-checkin-copy.ts, including that it was exceeded once in 100. */
export const DEFAULT_RACE_BY_ALLOWANCE_MIN = 30;

/** Which window an allowance actually came from, so a surface can be honest
 *  about it and a report can tell a live number from a fallback. */
export type RaceByBasis = "last-hour" | "today" | "last-7-days" | "default";

export interface RaceByAllowance {
  minutes: number;
  basis: RaceByBasis;
  /** Heats behind the figure. 0 when `basis` is "default". */
  n: number;
}

/**
 * How long to allow between the printed slot and the green flag.
 *
 * CASCADES BY SAMPLE SIZE, most recent first — the live picture when there is
 * enough of one, today when there is not, the trailing week when today is thin
 * (an opening hour, a quiet Tuesday), and the measured floor when all else fails.
 *
 * p90, NOT the median: this feeds a "racing by", and a bound that half the field
 * beats is not a bound. Callers must render it as an estimate — owner
 * 2026-08-17: "make sure we put est."
 */
export function raceByAllowance(windows: {
  lastHour: WaitStat | null;
  today: WaitStat | null;
  last7Days: WaitStat | null;
}): RaceByAllowance {
  const tiers: Array<[RaceByBasis, WaitStat | null]> = [
    ["last-hour", windows.lastHour],
    ["today", windows.today],
    ["last-7-days", windows.last7Days],
  ];
  for (const [basis, stat] of tiers) {
    if (!stat || stat.n < MIN_WINDOW_HEATS || stat.p90Ms == null) continue;
    // Never below zero: a window where everything went green early is not a
    // reason to tell a guest their race already happened.
    const minutes = Math.max(0, Math.round(stat.p90Ms / 60_000));
    return { minutes, basis, n: stat.n };
  }
  return { minutes: DEFAULT_RACE_BY_ALLOWANCE_MIN, basis: "default", n: 0 };
}

/** `m:ss`, for a board or a log line. Hours when a span earns them. */
export function formatWaitMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}
