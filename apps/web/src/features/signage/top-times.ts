/**
 * The top-times wall — every decision it makes, as pure functions.
 *
 * WHAT THIS SCREEN IS. The other face of the scores wall. `race-results` shows
 * the race that just came back in; this shows the FASTEST LAPS over a window —
 * today, the last seven days, or the month so far — as a hall of fame. Both are
 * the `race-results` scene, told apart by `resultsBoard.role`.
 *
 * WHY IT EXISTS. Two results walls on one track show byte-identical content,
 * and a Mega day makes exactly that of the Blue and Red pair: both follow the
 * one combined circuit. Splitting the pair by role is the same move `megaRole`
 * makes for the check-in boards and `pitMegaRole` for the pit signs.
 *
 * ALL THREE TIERS AT ONCE, IN COLUMNS (owner 2026-08-17) — not one tier per
 * slot. A racer walking past should find their own tier without waiting for the
 * board to come round to it.
 *
 * CLASS IS DATA, NOT CONFIG. Adult and junior are separate panels rather than
 * six columns, because six columns of eight names is a spreadsheet at reading
 * distance. A class with no records anywhere in the window earns no panel, so a
 * track with no junior racing today never rotates to an empty screen — and
 * nobody has to remember to configure that.
 *
 * PURE — no I/O, no clock, no Redis. The resolver lives in
 * service/top-times.server.ts; everything worth asserting on is here.
 */
import type { TrackKey } from "./track";

/** The windows a board can cycle through. A subset of RecordTimeRange —
 *  `year` and `alltime` belong to the kiosk hub and /leaderboards, where
 *  somebody is standing still and choosing; a wall is about recent racing. */
export type TopTimesRange = "today" | "week" | "month";

export type TopTimesClass = "adult" | "junior";

/** How many names a single tier column carries. Eight fits at a size that
 *  reads from across the kart return; more would shrink the type past it. */
export const TOP_N = 8;

export interface TopTimesRow {
  /** 1-based, as the upstream ranks them. */
  position: number;
  name: string;
  /** Pre-formatted lap ("28.442s" / "1:02.212") — see formatRecordTime. */
  score: string;
}

/** One tier's column: Starter, Intermediate or Pro. */
export interface TopTimesColumn {
  label: string;
  /** The tier's identity colour, from the shared records catalog. */
  color: string;
  rows: TopTimesRow[];
}

/** One screenful: a window and a class, with a column per tier. */
export interface TopTimesPanel {
  range: TopTimesRange;
  cls: TopTimesClass;
  columns: TopTimesColumn[];
}

export interface TopTimesView {
  track: TrackKey;
  /** Never empty when the view is non-null — a board with no panel would
   *  render nothing at all, so the resolver returns null instead. */
  panels: TopTimesPanel[];
}

export const RANGE_LABELS: Record<TopTimesRange, string> = {
  today: "Today",
  week: "This Week",
  month: "This Month",
};

/** The eyebrow over the board: "Today · Fastest Laps". Junior says so; adult
 *  does not, because unqualified means adult everywhere else in the building. */
export function panelTitle(panel: TopTimesPanel): string {
  const cls = panel.cls === "junior" ? "Junior " : "";
  return `${RANGE_LABELS[panel.range]} · ${cls}Fastest Laps`;
}

/**
 * Drop columns and panels that have nothing in them.
 *
 * A tier nobody set a lap in this window is a column of dashes, and a class
 * with no tiers left is a screenful of them — both are worse than not taking
 * the slot at all. Applied AFTER the fetch rather than before, because "did
 * anyone race junior today" is not something a config can know.
 */
export function prunePanels(panels: TopTimesPanel[]): TopTimesPanel[] {
  return panels
    .map((p) => ({ ...p, columns: p.columns.filter((c) => c.rows.length > 0) }))
    .filter((p) => p.columns.length > 0);
}

/**
 * Which panel is up right now.
 *
 * Derived from the shared clock the same way the ad rotation is, so two boards
 * on one playlist land on the same panel without talking to each other. The
 * caller passes the slot length; see SLOT_MS in director/schedule.
 */
export function panelAt(panels: TopTimesPanel[], nowMs: number, slotMs: number): TopTimesPanel {
  const i = Math.floor(nowMs / slotMs) % panels.length;
  // A negative clock would index backwards out of the array; nowMs is a real
  // epoch everywhere, so this only ever guards a test or a mocked clock.
  return panels[((i % panels.length) + panels.length) % panels.length];
}
