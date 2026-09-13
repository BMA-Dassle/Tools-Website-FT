import {
  SLOT_MINUTES,
  fmtMin,
  pctOf,
  type DayBounds,
  type LaneBlock,
  type LaneOccupancy,
} from "~/features/crm/availability/pure";
import type {
  AvailabilityPlacement,
  AvailabilitySection,
} from "~/features/crm/availability/contracts";
import type { ChipKind } from "~/features/crm/core/types";

/**
 * Pure presentation helpers for the availability screen — every string the
 * screen shows that is not a literal, and the row shaping the timeline draws.
 * Hook-free and import-light so `model.test.ts` can exercise them directly
 * (brief R12: components are tested through their pure modules).
 *
 * The row shaping is `crm-shared.js:500-506` ported: a lane gets its own row
 * when it has ANY occupancy that evening or when it is part of the placement;
 * every other lane collapses into a single "free all evening" band, unless the
 * planner has asked to see every lane.
 */

export const DURATION_LABELS: Record<number, string> = {
  60: "1 hour",
  90: "1.5 hours",
  120: "2 hours",
  180: "3 hours",
};

/** "1 hour" / "1.5 hours" / "2 hours" / "3 hours", and a sane fallback. */
export function durationLabel(minutes: number): string {
  const known = DURATION_LABELS[minutes];
  if (known) return known;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hours`;
}

/** What the prototype prints inside "free ⟨…⟩": `6:00 PM–8:00 PM`. */
export function windowLabel(start: number, dur: number): string {
  return `${fmtMin(start)}–${fmtMin(start + dur)}`;
}

/** `[13,14,15]` → `13–15`; a single lane is just its number. */
export function runLabel(run: readonly number[]): string {
  if (run.length === 0) return "";
  if (run.length === 1) return String(run[0]);
  return `${run[0]}–${run[run.length - 1]}`;
}

/** `13–17, 19–26` — the section header's "contiguous:" list. */
export function contiguousLabel(runs: readonly (readonly number[])[]): string {
  return runs.map(runLabel).join(", ");
}

/** Green when the section can take the party, amber when it has something, red when it has nothing. */
export function sectionChipKind(free: number, need: number): ChipKind {
  if (free >= need) return "won";
  return free > 0 ? "warn" : "lost";
}

/** `lanes 13–28` for a section header. */
export function sectionRangeLabel(lanes: readonly number[]): string {
  if (lanes.length === 0) return "no lanes";
  return `lanes ${lanes[0]}–${lanes[lanes.length - 1]}`;
}

/** Every half hour the request bar offers, inside the drawn day. */
export function startOptions(bounds: DayBounds): { value: number; label: string }[] {
  const out: { value: number; label: string }[] = [];
  for (let t = bounds.openMin; t < bounds.closeMin; t += SLOT_MINUTES) {
    out.push({ value: t, label: fmtMin(t) });
  }
  return out;
}

/**
 * "refreshed 12 s ago" — the real age, in the prototype's sentence.
 *
 * The mockup hard-coded "60 s ago"; a cached read can be anything from 0 to 60
 * seconds old and a planner deciding whether to trust a grid deserves the
 * actual number.
 */
export function freshnessLabel(readAtIso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(readAtIso);
  if (!Number.isFinite(ms) || ms < 0) return "refreshed just now";
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "refreshed just now";
  if (seconds < 90) return `refreshed ${seconds} s ago`;
  return `refreshed ${Math.round(seconds / 60)} min ago`;
}

export interface TimelineBar extends LaneBlock {
  /** Percentages across the track, already clamped to the drawn day. */
  left: number;
  width: number;
  title: string;
}

export type TimelineRow =
  | { type: "lane"; lane: number; picked: boolean; bars: TimelineBar[] }
  | { type: "free"; lanes: number[]; label: string };

export interface SectionView {
  name: string;
  rangeLabel: string;
  free: number;
  total: number;
  chipKind: ChipKind;
  contiguous: string;
  rows: TimelineRow[];
}

function barsFor(blocks: readonly LaneBlock[], bounds: DayBounds): TimelineBar[] {
  return blocks.map((b) => {
    const left = pctOf(b.start, bounds);
    return {
      ...b,
      left,
      width: pctOf(b.end, bounds) - left,
      title: `${b.label} · ${fmtMin(b.start)}–${fmtMin(b.end)}`,
    };
  });
}

export interface SectionViewInput {
  section: AvailabilitySection;
  lanes: readonly LaneOccupancy[];
  placement: AvailabilityPlacement | null;
  need: number;
  bounds: DayBounds;
  expanded: boolean;
}

/** One section of the timeline, rows and header, exactly as the prototype builds it. */
export function sectionView(input: SectionViewInput): SectionView {
  const { section, placement, need, bounds, expanded } = input;
  const byLane = new Map<number, LaneBlock[]>();
  for (const row of input.lanes) byLane.set(row.lane, row.blocks);
  const picked = new Set(placement?.lanes ?? []);

  // A lane earns its own row when it is busy at ANY point in the evening or
  // when it is part of the placement — the planner needs to see what is around
  // the lanes they are about to take, not only what clashes with the window.
  const ownRow = (lane: number) => (byLane.get(lane)?.length ?? 0) > 0 || picked.has(lane);

  const freeRuns: number[][] = [];
  let cur: number[] = [];
  for (const lane of section.lanes) {
    if (!ownRow(lane)) cur.push(lane);
    else {
      if (cur.length) freeRuns.push(cur);
      cur = [];
    }
  }
  if (cur.length) freeRuns.push(cur);
  const runStart = new Map(freeRuns.map((run) => [run[0], run]));

  const rows: TimelineRow[] = [];
  for (const lane of section.lanes) {
    if (expanded || ownRow(lane)) {
      rows.push({
        type: "lane",
        lane,
        picked: picked.has(lane),
        bars: barsFor(byLane.get(lane) ?? [], bounds),
      });
      continue;
    }
    const run = runStart.get(lane);
    if (run) {
      rows.push({
        type: "free",
        lanes: run,
        label: run.length === 1 ? "free all evening" : `${run.length} lanes free all evening`,
      });
    }
  }

  return {
    name: section.name,
    rangeLabel: sectionRangeLabel(section.lanes),
    free: section.free,
    total: section.lanes.length,
    chipKind: sectionChipKind(section.free, need),
    contiguous: contiguousLabel(section.runs),
    rows,
  };
}

/** The band that marks the requested window across the whole grid. */
export function windowBand(
  start: number,
  dur: number,
  bounds: DayBounds,
): { left: number; width: number } {
  const left = pctOf(start, bounds);
  return { left, width: pctOf(start + dur, bounds) - left };
}

/** `Sat, Oct 17 · Lee Health · 60 guests → 10 lanes` (`crm-shared.js:511`). */
export function subtitleFor(parts: {
  dateLabel: string;
  title: string | null;
  guests: number;
  need: number;
}): string {
  const head = parts.title ? `${parts.dateLabel} · ${parts.title}` : parts.dateLabel;
  return `${head} · ${parts.guests} guests → ${parts.need} lanes`;
}

/**
 * The same line in KARTING units.
 *
 * FastTrax has no lanes at all, so "30 guests → 5 lanes" over a heat grid is
 * simply false — the prototype never showed FT on this screen (it mapped FT to
 * HPFM, `crm-shared.js:511`), and this is the honest replacement. `heats` is
 * `heatsNeeded` from the heats read; it is 0 until that read lands, and the
 * arrow is dropped rather than printed as "→ 0 heats".
 */
export function heatsSubtitleFor(parts: {
  dateLabel: string;
  title: string | null;
  racers: number;
  heats: number;
}): string {
  const head = parts.title ? `${parts.dateLabel} · ${parts.title}` : parts.dateLabel;
  const tail =
    parts.heats > 0 ? `${parts.racers} racers → ${parts.heats} heats` : `${parts.racers} racers`;
  return `${head} · ${tail}`;
}

/** Title and sub for the topbar, by what the route actually answered. */
export function screenHeadFor(parts: {
  source: "lanes" | "heats" | "unavailable" | null;
  centreShort: string;
  dateLabel: string;
  title: string | null;
  guests: number;
  need: number;
  heats: number;
}): { title: string; sub: string } {
  if (parts.source === "heats") {
    return {
      title: `Heat availability · ${parts.centreShort}`,
      sub: heatsSubtitleFor({
        dateLabel: parts.dateLabel,
        title: parts.title,
        racers: parts.guests,
        heats: parts.heats,
      }),
    };
  }
  return {
    title: `Lane availability · ${parts.centreShort}`,
    sub: subtitleFor({
      dateLabel: parts.dateLabel,
      title: parts.title,
      guests: parts.guests,
      need: parts.need,
    }),
  };
}

/**
 * What the heats panel shows, decided before any JSX.
 *
 * `unavailable` is the case that was wrong: the heats route takes care to
 * answer "Heat availability could not be read from the centre just now" and the
 * panel threw it away, telling the planner the centre had published no day
 * planner — a false explanation for a vendor outage or a missing credential.
 */
export type HeatsPanelState = "unavailable" | "grid" | "empty";

export function heatsPanelState(data: {
  source: "heats" | "unavailable";
  selectedResourceId: string | null;
  resources: readonly { resourceId: string; blocks: readonly unknown[] }[];
}): HeatsPanelState {
  if (data.source === "unavailable") return "unavailable";
  const selected = data.resources.find((r) => r.resourceId === data.selectedResourceId);
  return selected && selected.blocks.length > 0 ? "grid" : "empty";
}

/** One meter row of the deal rail's mini availability (`crm-shared.js:318`). */
export interface MiniSectionRow {
  name: string;
  free: number;
  total: number;
  pct: number;
  tone: "good" | "warn" | "crit";
  n: string;
}

/**
 * The rail card's rows: one per section, `free / lanes.length`, coloured the
 * prototype's way — good above half free, warn while anything is left, crit at
 * nothing.
 */
export function miniSectionRows(sections: readonly AvailabilitySection[]): MiniSectionRow[] {
  return sections.map((s) => {
    const total = s.lanes.length;
    const ratio = total > 0 ? s.free / total : 0;
    return {
      name: s.name,
      free: s.free,
      total,
      pct: total > 0 ? (s.free / total) * 100 : 0,
      tone: ratio > 0.5 ? "good" : s.free ? "warn" : "crit",
      n: `${s.free} of ${total} free`,
    };
  });
}

/**
 * The URL a "Hold these lanes" click opens — the builder (C5), carrying the pick.
 *
 * MACHINE-READABLE VALUES ONLY. The first cut passed `runLabel(lanes)` —
 * `"13–15"` with a U+2013 en dash — which would have made C5 split a display
 * string on a typographic character to recover two lane numbers. `firstLane`
 * and `count` say the same thing without parsing, `start` is minutes from
 * midnight (the unit every time on this wire uses) and `section` is the section
 * name the engine picked. The en-dash form stays where it belongs: on screen.
 *
 * C5 CONTRACT: `?firstLane=13&count=3&start=1080&section=Regular`. The brief's
 * hand-off shape is `{productId, qty, start}` — `count` IS the qty and C5 picks
 * the productId from `section` and the centre, because this screen has no
 * product catalogue and must not guess one.
 */
export function holdHref(
  base: string,
  leadPublicId: string,
  placement: AvailabilityPlacement,
  start: number,
): string {
  const p = new URLSearchParams({
    firstLane: String(placement.lanes[0] ?? ""),
    count: String(placement.lanes.length),
    start: String(start),
    section: placement.section,
  });
  return `${base}/builder/${encodeURIComponent(leadPublicId)}?${p.toString()}`;
}
