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
}

/** What the fold needs from a briefing record — a structural subset, so the
 *  metrics do not drag the whole log type (or its imports) around with them. */
export interface BriefingSpanSource {
  sessionId: string;
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
  heatNumber: number | null;
  raceType: string | null;
  /** First racer through the desk → sent to the briefing room. */
  checkinToRoomMs: number | null;
  /** How spread out the group's own arrivals were. 0 for a group check-in. */
  checkinSpreadMs: number | null;
  /** Called → sent to the room. The desk's own half of the wait. */
  calledToRoomMs: number | null;
  /** Sent to the room → the film actually rolling (the walk, plus any wait). */
  roomToFilmMs: number | null;
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
  "checkinToRoomMs",
  "checkinSpreadMs",
  "calledToRoomMs",
  "roomToFilmMs",
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
    heatNumber: briefing.heatNumber,
    raceType: briefing.raceType,
    checkinToRoomMs: at("checkinToRoomMs", briefing.checkinFirstAtMs, briefing.sentAtMs),
    checkinSpreadMs: at("checkinSpreadMs", briefing.checkinFirstAtMs, briefing.checkinLastAtMs),
    calledToRoomMs: at("calledToRoomMs", briefing.calledAtMs, briefing.sentAtMs),
    roomToFilmMs: at("roomToFilmMs", briefing.sentAtMs, briefing.startedAtMs),
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

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
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
      minMs: values.length ? values[0] : null,
      maxMs: values.length ? values[values.length - 1] : null,
      discarded,
    };
  }
  return out;
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
