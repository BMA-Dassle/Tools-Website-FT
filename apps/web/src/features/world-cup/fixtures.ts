/**
 * 2026 FIFA World Cup — remaining-match fixture config for World Cup VIP Bowling.
 *
 * SINGLE SOURCE OF TRUTH for which matches are sellable, when they kick off,
 * and when the whole feature self-expires. Consumed by the match picker step,
 * the /book/v2 tile, the site popup, AND the server-side reserve validation —
 * client and server import the same table, so the server never trusts a
 * client-supplied match time (see features/world-cup/service.ts).
 *
 * Maintenance: as knockout rounds resolve, edit the `teams` strings below
 * (config-only commit). Dates/kickoffs/venues are fixed by FIFA and verified
 * 2026-07-03 (ESPN/CBS/FOX). All times are ET — both HeadPinz centers are ET,
 * and every remaining kickoff is exactly on the hour.
 *
 * All helpers take `nowMs` explicitly (no module-level Date.now()) so they
 * are pure and unit-testable.
 */

export type WorldCupRound = "Round of 16" | "Quarterfinal" | "Semifinal" | "Third Place" | "Final";

export interface WorldCupFixture {
  /** Stable id — persisted into booking metadata; never renumber. */
  id: string;
  round: WorldCupRound;
  /** ET calendar date, YYYY-MM-DD. */
  dateEt: string;
  /** ET kickoff hour (0-23). Every remaining 2026 kickoff is on the hour. */
  kickoffHourEt: number;
  /** "USA vs Belgium" — null until the bracket resolves (renders "Teams TBD"). */
  teams: string | null;
  /** Host stadium city — display flavor only. */
  venue?: string;
}

/** Lane window sold per match: 2.5 hours from kickoff (owner decision 7/3). */
export const WORLD_CUP_WINDOW_MINUTES = 150;

/**
 * Hide a match this close to (or past) kickoff. The availability route can't
 * probe a start closer than now+15 min anyway, so a later cutoff would only
 * surface cards that can never hold.
 */
export const WORLD_CUP_BOOKING_CUTOFF_MS = 15 * 60_000;

export const WORLD_CUP_FIXTURES: WorldCupFixture[] = [
  {
    id: "r16-1",
    round: "Round of 16",
    dateEt: "2026-07-04",
    kickoffHourEt: 13,
    teams: "Canada vs Morocco",
    venue: "Houston",
  },
  {
    id: "r16-2",
    round: "Round of 16",
    dateEt: "2026-07-04",
    kickoffHourEt: 17,
    teams: "Paraguay vs France",
    venue: "Philadelphia",
  },
  {
    id: "r16-3",
    round: "Round of 16",
    dateEt: "2026-07-05",
    kickoffHourEt: 16,
    teams: "Brazil vs Norway",
    venue: "New York / New Jersey",
  },
  {
    id: "r16-4",
    round: "Round of 16",
    dateEt: "2026-07-05",
    kickoffHourEt: 20,
    teams: "England vs Mexico",
    venue: "Mexico City",
  },
  {
    id: "r16-5",
    round: "Round of 16",
    dateEt: "2026-07-06",
    kickoffHourEt: 15,
    teams: "Portugal vs Spain",
    venue: "Dallas",
  },
  {
    id: "r16-6",
    round: "Round of 16",
    dateEt: "2026-07-06",
    kickoffHourEt: 20,
    teams: "USA vs Belgium",
    venue: "Seattle",
  },
  {
    id: "r16-7",
    round: "Round of 16",
    dateEt: "2026-07-07",
    kickoffHourEt: 12,
    teams: null,
    venue: "Atlanta",
  },
  {
    id: "r16-8",
    round: "Round of 16",
    dateEt: "2026-07-07",
    kickoffHourEt: 16,
    teams: null,
    venue: "San Francisco Bay Area",
  },
  {
    id: "qf-1",
    round: "Quarterfinal",
    dateEt: "2026-07-09",
    kickoffHourEt: 16,
    teams: null,
    venue: "Boston",
  },
  {
    id: "qf-2",
    round: "Quarterfinal",
    dateEt: "2026-07-10",
    kickoffHourEt: 15,
    teams: null,
    venue: "Los Angeles",
  },
  {
    id: "qf-3",
    round: "Quarterfinal",
    dateEt: "2026-07-11",
    kickoffHourEt: 17,
    teams: null,
    venue: "Miami",
  },
  {
    id: "qf-4",
    round: "Quarterfinal",
    dateEt: "2026-07-11",
    kickoffHourEt: 21,
    teams: null,
    venue: "Kansas City",
  },
  {
    id: "sf-1",
    round: "Semifinal",
    dateEt: "2026-07-14",
    kickoffHourEt: 15,
    teams: null,
    venue: "Dallas",
  },
  {
    id: "sf-2",
    round: "Semifinal",
    dateEt: "2026-07-15",
    kickoffHourEt: 15,
    teams: null,
    venue: "Atlanta",
  },
  {
    id: "3rd-1",
    round: "Third Place",
    dateEt: "2026-07-18",
    kickoffHourEt: 17,
    teams: null,
    venue: "Miami",
  },
  {
    id: "final",
    round: "Final",
    dateEt: "2026-07-19",
    kickoffHourEt: 15,
    teams: null,
    venue: "New York / New Jersey",
  },
];

/**
 * Popup gate: the USA250 popup runs through July 4 and self-expires at this
 * exact instant (see components/Usa250PromoPopup.tsx EXPIRES_AT_MS) — starting
 * the World Cup popup here guarantees the two never overlap (owner 7/3).
 * The /book/v2 tile is NOT delayed.
 */
export const WORLD_CUP_POPUP_STARTS_AT_MS = Date.parse("2026-07-05T00:00:00-04:00");

/** Feature self-expiry: final kickoff (7/19 3 PM ET) + the 150-min window. */
export const WORLD_CUP_ENDS_AT_MS = Date.parse("2026-07-19T17:30:00-04:00");

/* ───────────────────────── experience slugs ───────────────────────── */

export type WorldCupBand = "mon-thur" | "fri-sun";

/**
 * Weekday/weekend pricing is modeled as two DB experiences (mirrors the
 * existing vip-mon-thur / vip-fri-sun split): $112.50/lane vs $137.50/lane
 * (normal 1.5-hr + 1-hr VIP rates). Seeded by scripts/seed-world-cup-vip.ts.
 */
export const WORLD_CUP_SLUGS: Record<WorldCupBand, string> = {
  "mon-thur": "world-cup-vip-mon-thur",
  "fri-sun": "world-cup-vip-fri-sun",
};

export const WORLD_CUP_SLUG_PREFIX = "world-cup-";

export function isWorldCupSlug(slug: string | null | undefined): boolean {
  return !!slug && slug.startsWith(WORLD_CUP_SLUG_PREFIX);
}

/** Fri(5)/Sat(6)/Sun(0) → fri-sun; Mon-Thu → mon-thur. Noon-anchored so the
 *  YYYY-MM-DD never rolls a day (PromoLanding precedent). */
export function weekendBand(dateEt: string): WorldCupBand {
  const dow = new Date(`${dateEt}T12:00:00-04:00`).getUTCDay();
  return dow === 5 || dow === 6 || dow === 0 ? "fri-sun" : "mon-thur";
}

export function worldCupSlugForDate(dateEt: string): string {
  return WORLD_CUP_SLUGS[weekendBand(dateEt)];
}

/* ───────────────────────── lookups + windows ──────────────────────── */

/** ET kickoff instant. July 2026 is EDT (-04:00) throughout — fixed offset is safe. */
export function fixtureKickoffMs(f: WorldCupFixture): number {
  const hh = String(f.kickoffHourEt).padStart(2, "0");
  return Date.parse(`${f.dateEt}T${hh}:00:00-04:00`);
}

export function findFixture(id: string): WorldCupFixture | null {
  return WORLD_CUP_FIXTURES.find((f) => f.id === id) ?? null;
}

export function fixturesOn(dateEt: string): WorldCupFixture[] {
  return WORLD_CUP_FIXTURES.filter((f) => f.dateEt === dateEt);
}

/** Matches still sellable: kickoff at least the booking cutoff away. */
export function upcomingFixtures(nowMs: number): WorldCupFixture[] {
  return WORLD_CUP_FIXTURES.filter(
    (f) => fixtureKickoffMs(f) - WORLD_CUP_BOOKING_CUTOFF_MS > nowMs,
  );
}

/** Whole feature (tile + picker) lives until the final's window ends. */
export function worldCupWindowActive(nowMs: number): boolean {
  return nowMs < WORLD_CUP_ENDS_AT_MS && upcomingFixtures(nowMs).length > 0;
}

/** Popup lives from 7/5 00:00 ET (post-USA250) until the feature expires. */
export function worldCupPopupActive(nowMs: number): boolean {
  return nowMs >= WORLD_CUP_POPUP_STARTS_AT_MS && worldCupWindowActive(nowMs);
}

/* ───────────────────────── display labels ─────────────────────────── */

/** "8 PM" / "12 PM" — kickoffs are on the hour, skip the ":00". */
export function fixtureTimeLabel(f: WorldCupFixture): string {
  const h = f.kickoffHourEt;
  const ampm = h >= 12 ? "PM" : "AM";
  const disp = h % 12 === 0 ? 12 : h % 12;
  return `${disp} ${ampm}`;
}

/** "Mon, Jul 6" — noon-anchored parse so the date never rolls. */
export function fixtureDayLabel(f: WorldCupFixture): string {
  return new Date(`${f.dateEt}T12:00:00-04:00`).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** Customer-facing matchup: real teams once known, else the round + TBD. */
export function fixtureLabel(f: WorldCupFixture): string {
  return f.teams ?? `${f.round} — Teams TBD`;
}

/** Staff-facing one-liner: "USA vs Belgium — Mon, Jul 6 8 PM". */
export function fixtureStaffLabel(f: WorldCupFixture): string {
  return `${fixtureLabel(f)} — ${fixtureDayLabel(f)} ${fixtureTimeLabel(f)}`;
}

/* ─────────────────── bookedAt ↔ fixture matching ──────────────────── */

/** ET wall-clock parts of an ISO instant (QAMF bookedAt carries an offset). */
function etParts(iso: string): { date: string; hour: number; minute: number } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0; // midnight edge from hour12:false
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour,
    minute: Number(get("minute")),
  };
}

/** True when `bookedAtIso` is EXACTLY this fixture's kickoff (ET date+hour, :00). */
export function fixtureMatchesBookedAt(f: WorldCupFixture, bookedAtIso: string): boolean {
  const p = etParts(bookedAtIso);
  return !!p && p.date === f.dateEt && p.hour === f.kickoffHourEt && p.minute === 0;
}

/** The fixture a bookedAt lands on, if any — server validation entry point. */
export function fixtureForBookedAt(bookedAtIso: string): WorldCupFixture | null {
  return WORLD_CUP_FIXTURES.find((f) => fixtureMatchesBookedAt(f, bookedAtIso)) ?? null;
}
