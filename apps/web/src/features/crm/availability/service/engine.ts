/**
 * Lane-availability engine — PURE. No vendor, no Neon, no Redis, no clock.
 *
 * Ported line for line from the prototype (`crm-shared.js:488-522`), which is
 * the acceptance spec for this screen:
 *
 *   need        = ceil(guests / 6), at least 1
 *   laneFreeIn  = no occupancy anywhere inside the requested window
 *   runs        = contiguous free lanes, per section, in lane order
 *   best        = the first run long enough, taken from an ODD lane because
 *                 QAMF books lanes in pairs (odd + even), with a Regular
 *                 section beating a VIP one when both fit
 *   alternates  = ±30…180 minutes in 30-minute steps, later before earlier,
 *                 the first three that fit
 *
 * The one deliberate difference from the prototype: the prototype asked its
 * slot generator whether each 30-minute slot was busy, because its occupancy
 * WAS a slot function. Real QAMF reservations start and end on arbitrary
 * minutes, so `laneFreeIn` here tests half-open interval overlap against the
 * requested window instead. On slot-aligned data the two agree exactly, which
 * is what `engine.test.ts` pins by deriving its expectations from the ported
 * generator rather than from any copied string.
 *
 * Every time is MINUTES FROM MIDNIGHT in the centre's own day (America/New_York).
 * Nothing here parses or formats a date — the transport does that once, on the
 * way in, so the engine cannot pick up the runner's UTC clock.
 */

/** QAMF/ops rule of thumb: six guests to a lane. */
export const GUESTS_PER_LANE = 6;

/** The timeline's resolution, and the step the request bar offers. */
export const SLOT_MINUTES = 30;

/** The prototype's evening window: 4 PM to 10 PM (`crm-data.js:425`). */
export const EVENING_OPEN_MIN = 16 * 60;
export const EVENING_CLOSE_MIN = 22 * 60;

/** Alternate search: ±30…180 minutes, in half-hour steps, at most three shown. */
export const ALTERNATE_STEP_MIN = 30;
export const ALTERNATE_MAX_OFFSET_MIN = 180;
export const MAX_ALTERNATES = 3;

/** The section name the engine de-prioritises when a plain lane would also do. */
export const VIP_SECTION_NAME = "VIP";

export type OccupancyKind = "league" | "party" | "walkin" | "maint";

/** One occupied stretch on one lane, in minutes from midnight, half-open. */
export interface LaneBlock {
  kind: OccupancyKind;
  label: string;
  start: number;
  end: number;
}

export interface LaneOccupancy {
  lane: number;
  blocks: LaneBlock[];
}

/** A named, contiguous group of lane numbers ("VIP", lanes 5-12). */
export interface LaneSection {
  name: string;
  lanes: number[];
}

/** The requested block: start (minutes from midnight) and length in minutes. */
export interface RequestWindow {
  start: number;
  dur: number;
}

export interface DayBounds {
  openMin: number;
  closeMin: number;
}

/**
 * Lane sections per centre (brief §1.8, confirmed against
 * `reference_headpinz_lane_sections`): HPFM 1-4 Old Time, 5-12 VIP, 13-28
 * Regular; Naples 1-24 Regular, 25-32 VIP. FastTrax is karting — it has no
 * bowling grid at all and goes down the heats path instead.
 */
export const LANE_SECTIONS: Record<"HPFM" | "HPN", readonly LaneSection[]> = {
  HPFM: [
    { name: "Old Time Lanes", lanes: [1, 2, 3, 4] },
    { name: "VIP", lanes: [5, 6, 7, 8, 9, 10, 11, 12] },
    { name: "Regular", lanes: Array.from({ length: 16 }, (_, i) => 13 + i) },
  ],
  HPN: [
    { name: "Regular", lanes: Array.from({ length: 24 }, (_, i) => 1 + i) },
    { name: "VIP", lanes: Array.from({ length: 8 }, (_, i) => 25 + i) },
  ],
};

/** How many lanes a party of this size needs. */
export function lanesNeeded(guests: number): number {
  return Math.max(1, Math.ceil(guests / GUESTS_PER_LANE));
}

/** Every 30-minute slot start in the day window, ascending. */
export function slotsBetween(bounds: DayBounds): number[] {
  const out: number[] = [];
  for (let t = bounds.openMin; t < bounds.closeMin; t += SLOT_MINUTES) out.push(t);
  return out;
}

/** Hourly tick marks, inclusive of both ends (the timeline's axis). */
export function ticksBetween(bounds: DayBounds): number[] {
  const out: number[] = [];
  for (let t = bounds.openMin; t <= bounds.closeMin; t += 60) out.push(t);
  return out;
}

/** The first block covering this slot, or null — what one timeline cell shows. */
export function blockAtSlot(blocks: readonly LaneBlock[], slotMin: number): LaneBlock | null {
  const end = slotMin + SLOT_MINUTES;
  return blocks.find((b) => b.start < end && b.end > slotMin) ?? null;
}

/** Is this lane free for the WHOLE requested window? */
export function laneFreeIn(blocks: readonly LaneBlock[], win: RequestWindow): boolean {
  const end = win.start + win.dur;
  return !blocks.some((b) => b.start < end && b.end > win.start);
}

export interface SectionRuns {
  section: LaneSection;
  /** Contiguous free lane numbers, in lane order. */
  runs: number[][];
  /** Total free lanes in the section for this window. */
  free: number;
}

/**
 * Lanes the VENDOR reported, when the caller knows.
 *
 * `LANE_SECTIONS` is our own map of what each centre has; `grid.lanes` is what
 * QAMF answered on this read. When they disagree — a partial `GET /lanes`, a
 * centre whose numbering changed — the missing lane is UNKNOWN, not free, and
 * a verdict that offered it would be a lane the front desk cannot open. Omit
 * the set and every lane in the sections counts as known, which is what the
 * pure tests drive.
 */
export type KnownLanes = ReadonlySet<number> | undefined;

function laneAvailable(
  lane: number,
  occupancy: ReadonlyMap<number, LaneBlock[]>,
  win: RequestWindow,
  knownLanes: KnownLanes,
): boolean {
  if (knownLanes && !knownLanes.has(lane)) return false;
  return laneFreeIn(occupancy.get(lane) ?? [], win);
}

/** Contiguous free runs per section for one window (`crm-shared.js:493`). */
export function sectionRuns(
  sections: readonly LaneSection[],
  occupancy: ReadonlyMap<number, LaneBlock[]>,
  win: RequestWindow,
  knownLanes?: KnownLanes,
): SectionRuns[] {
  return sections.map((section) => {
    const runs: number[][] = [];
    let cur: number[] = [];
    for (const lane of section.lanes) {
      if (laneAvailable(lane, occupancy, win, knownLanes)) {
        cur.push(lane);
      } else {
        if (cur.length) runs.push(cur);
        cur = [];
      }
    }
    if (cur.length) runs.push(cur);
    return { section, runs, free: runs.reduce((a, r) => a + r.length, 0) };
  });
}

export interface BestRun {
  section: LaneSection;
  /** Exactly `need` lanes, starting on an odd one. */
  lanes: number[];
  /** The whole contiguous free run the lanes were taken from. */
  run: number[];
  startsOdd: boolean;
}

/**
 * The best placement for one window, or null (`crm-shared.js:494` verbatim).
 *
 * A run that is long enough still fails when it starts on an EVEN lane and has
 * no spare lane to shift onto: QAMF books lanes as odd/even pairs, so a block
 * that starts even splits a pair down the middle and the front desk cannot
 * take it. Hence the `slice(startsOdd ? 0 : 1, …)` and the length re-check.
 *
 * Preference, in the prototype's own order: a section that is not VIP beats
 * one that is (keep the premium lanes sellable), otherwise the first run found
 * in section order wins.
 */
export function bestRun(
  sections: readonly LaneSection[],
  occupancy: ReadonlyMap<number, LaneBlock[]>,
  win: RequestWindow,
  need: number,
  knownLanes?: KnownLanes,
): BestRun | null {
  let best: BestRun | null = null;
  for (const { section, runs } of sectionRuns(sections, occupancy, win, knownLanes)) {
    for (const run of runs) {
      if (run.length < need) continue;
      const startsOdd = run[0] % 2 === 1;
      const offset = startsOdd ? 0 : 1;
      const lanes = run.slice(offset, offset + need);
      if (lanes.length !== need) continue;
      const better =
        !best ||
        (section.name !== VIP_SECTION_NAME && best.section.name === VIP_SECTION_NAME) ||
        lanes.length > best.lanes.length;
      if (better) best = { section, lanes, run, startsOdd };
    }
  }
  return best;
}

export interface Alternate {
  window: RequestWindow;
  best: BestRun;
}

/**
 * Nearest windows that DO fit, ±30…180 minutes (`crm-shared.js:496`).
 * Later before earlier at each offset, and never outside the day bounds.
 */
export function alternateWindows(
  sections: readonly LaneSection[],
  occupancy: ReadonlyMap<number, LaneBlock[]>,
  win: RequestWindow,
  need: number,
  bounds: DayBounds,
  knownLanes?: KnownLanes,
): Alternate[] {
  const out: Alternate[] = [];
  for (
    let d = ALTERNATE_STEP_MIN;
    d <= ALTERNATE_MAX_OFFSET_MIN && out.length < MAX_ALTERNATES;
    d += ALTERNATE_STEP_MIN
  ) {
    for (const sign of [1, -1]) {
      const candidate: RequestWindow = { start: win.start + sign * d, dur: win.dur };
      if (candidate.start < bounds.openMin) continue;
      if (candidate.start + candidate.dur > bounds.closeMin) continue;
      const best = bestRun(sections, occupancy, candidate, need, knownLanes);
      if (best) out.push({ window: candidate, best });
      if (out.length >= MAX_ALTERNATES) break;
    }
  }
  return out;
}

export interface VerdictInput {
  sections: readonly LaneSection[];
  occupancy: ReadonlyMap<number, LaneBlock[]>;
  window: RequestWindow;
  guests: number;
  bounds: DayBounds;
  /** Lanes the vendor reported; anything outside it is unknown, so not free. */
  knownLanes?: KnownLanes;
}

export interface Verdict {
  need: number;
  fits: boolean;
  best: BestRun | null;
  alternates: Alternate[];
  sections: SectionRuns[];
}

/** The whole decision for one request, in one call. */
export function evaluate(input: VerdictInput): Verdict {
  const need = lanesNeeded(input.guests);
  const known = input.knownLanes;
  const best = bestRun(input.sections, input.occupancy, input.window, need, known);
  return {
    need,
    fits: best !== null,
    best,
    alternates: best
      ? []
      : alternateWindows(input.sections, input.occupancy, input.window, need, input.bounds, known),
    sections: sectionRuns(input.sections, input.occupancy, input.window, known),
  };
}

/**
 * Merge touching blocks that say the same thing, so the timeline draws one bar
 * for a three-hour league instead of six (`crm-shared.js:497`). Input must be
 * sorted by start; output is too.
 */
export function mergeAdjacent(blocks: readonly LaneBlock[]): LaneBlock[] {
  const out: LaneBlock[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === b.kind && prev.label === b.label && prev.end >= b.start) {
      prev.end = Math.max(prev.end, b.end);
    } else {
      out.push({ ...b });
    }
  }
  return out;
}

/** Clamp blocks to the day window and drop anything that falls outside it. */
export function clampBlocks(blocks: readonly LaneBlock[], bounds: DayBounds): LaneBlock[] {
  const out: LaneBlock[] = [];
  for (const b of blocks) {
    const start = Math.max(b.start, bounds.openMin);
    const end = Math.min(b.end, bounds.closeMin);
    if (end > start) out.push({ ...b, start, end });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** `16*60+30` → `"4:30 PM"` (`crm-data.js:418`). */
export function fmtMin(minutes: number): string {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const ap = hh >= 12 ? "PM" : "AM";
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${ap}`;
}

/** `"18:30"` / `"18:30:00"` → 1110. Anything unparseable → null. */
export function parseClockMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * The day window the timeline draws: the prototype's evening, widened just far
 * enough to contain the request. A 10 AM corporate booking still renders
 * instead of falling off the left edge, while an ordinary evening request
 * produces exactly the prototype's 4-10 PM axis.
 */
export function boundsFor(win: RequestWindow): DayBounds {
  const openMin = Math.min(EVENING_OPEN_MIN, Math.floor(win.start / 60) * 60);
  const closeMin = Math.max(EVENING_CLOSE_MIN, Math.ceil((win.start + win.dur) / 60) * 60);
  return { openMin, closeMin };
}

/** Left/width percentages for a bar on the timeline track. */
export function pctOf(minutes: number, bounds: DayBounds): number {
  const span = bounds.closeMin - bounds.openMin;
  if (span <= 0) return 0;
  return ((minutes - bounds.openMin) / span) * 100;
}
