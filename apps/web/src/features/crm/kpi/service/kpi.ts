/**
 * The KPI dashboard's one read (`GET /api/admin/crm/kpi`).
 *
 * TWO POPULATIONS, deliberately, because the prototype's single `leads` number
 * was doing two different jobs:
 *   • the BMI mirror's portal BUCKETS (confirmed / quoted / lead) — the
 *     conversion denominator and every money figure, so the C7 smoke can put
 *     this page beside the portal's KPI Dashboard and compare bucket for
 *     bucket;
 *   • our own `crm_leads` — the source split, the funnel by OUR statuses, the
 *     lost reasons and the response times, none of which BMI knows about.
 * Each tile's tooltip names which one it is reading.
 *
 * TEAM IS NOT Σ REPS. `team` counts EVERY project in the bucket, attributed or
 * not — that is the figure the portal prints and the one the owner compares
 * against. `reps[]` is the attributed split, so it can be smaller; the gap is
 * `attribution.none` and the screen prints it under the tiles rather than
 * quietly losing somebody's bookings into a rounding difference. With a rep
 * filter on, `team` IS that rep's row.
 */

import { listReps } from "~/features/crm/reps";
import { CENTRES, isCentreCode } from "~/features/crm/core/centres";
import type { CentreCode, CrmRep, CrmUser, OfficeClientKey } from "~/features/crm/core/types";
import type {
  AttributionCoverage,
  DepositsDue,
  FunnelRow,
  KpiResponse,
  KpiWindow,
  LostRow,
  MonthlyGoalRow,
  RepKpi,
} from "../contracts";
import {
  bookedByDayRollup,
  depositsDue,
  eventWindowRollup,
  funnelByStatus,
  lastYearHostCounts,
  leadsBySource,
  lostReasons,
  monthlyRollup,
  reachOutCount,
  responseMinutes,
  type MirrorRollupRow,
} from "../data/measure-db";
import { listGoalsForYear } from "../data/goals-db";
import { buildAttributionIndex, countCoverage, emptyCoverage } from "./attribution";
import { bucketOf, isLeadState } from "./buckets";
import { median, pacingFor } from "./pacing";
import {
  elapsedDays,
  lastYearYmd,
  monthShort,
  monthWindow,
  resolveKpiWindow,
  type DayPair,
} from "./windows";

export interface KpiQuery {
  month?: string | null;
  quarter?: string | null;
  /** `crm_reps.slug`, or null for the team. Ignored for a rep (see below). */
  rep?: string | null;
  centre?: string | null;
  now?: Date;
}

/**
 * A rep id that can never match a row, for the `$n IS NULL OR col = $n` lead
 * filters: `NULL` there means "the whole team", which is exactly what a rep
 * with no `crm_reps` row must NOT be shown. `crm_reps.id` is a BIGSERIAL and
 * starts at 1, so 0 is a value no rep can hold.
 */
const NOBODY_REP_ID = "0";

const SOURCE_LABELS: Record<string, string> = {
  web: "Web form",
  historical: "Last year",
  phone: "Phone",
  referral: "Referral",
  cold: "Cold list",
  walkin: "Walk-in",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function emptyRepKpi(rep: CrmRep | null, slug: string, name: string): RepKpi {
  return {
    repId: rep?.id ?? null,
    slug,
    firstName: rep?.firstName ?? name,
    displayName: rep?.displayName ?? name,
    initials: rep?.initials ?? "··",
    bookedCents: 0,
    lastYearToDateCents: 0,
    lastYearFullCents: 0,
    quotedCents: 0,
    goalCents: 0,
    leads: 0,
    confirmed: 0,
  };
}

/** The reps a director sees on this page, in roster order (the prototype's four). */
function measurableReps(reps: readonly CrmRep[]): CrmRep[] {
  return reps.filter((r) => r.active && (r.role === "rep" || r.role === "bucket"));
}

interface Totals {
  bookedCents: number;
  quotedCents: number;
  confirmed: number;
  leads: number;
}

function addRollup(into: Totals, row: MirrorRollupRow): void {
  const bucket = bucketOf(row.stateName);
  if (bucket === "confirmed") {
    into.bookedCents += row.cents;
    into.confirmed += row.projects;
  } else if (bucket === "quoted") {
    into.quotedCents += row.cents;
  }
  if (isLeadState(row.stateName)) into.leads += row.projects;
}

function zeroTotals(): Totals {
  return { bookedCents: 0, quotedCents: 0, confirmed: 0, leads: 0 };
}

/**
 * VISIBILITY IS ENFORCED HERE, not by hiding UI (brief C7: "A rep sees their
 * own accountability; the director sees everyone's… enforced server-side in the
 * route, not by hiding UI"). The prototype shows the same split on this screen
 * — `repIds = isDirector() ? [four reps] : [S.viewAs]` (crm-shared.js:374).
 *
 * So a `?rep=` from a rep is IGNORED, not obeyed and not refused: the screen is
 * theirs, the filter simply does not apply, and a hand-typed URL cannot read a
 * colleague's booked revenue. A rep with no `crm_reps` row sees zeroes and a
 * screen that says why — never the team total by accident, which is what
 * `repId: null` would have meant to every lead query below.
 */
export async function kpiDashboard(
  user: CrmUser,
  query: KpiQuery = {},
): Promise<Omit<KpiResponse, "ok">> {
  const now = query.now ?? new Date();
  const window = resolveKpiWindow({ month: query.month, quarter: query.quarter }, now);
  const centre: CentreCode | null =
    query.centre && isCentreCode(query.centre) ? query.centre : null;
  const locationId = centre ? CENTRES[centre].locationId : null;
  const centerCode = centre ? CENTRES[centre].centerCode : null;

  const allReps = await listReps({ includeInactive: true });
  const index = buildAttributionIndex(allReps);
  const roster = measurableReps(allReps);
  const director = user.role === "director";
  const ownRep = user.rep ? (roster.find((r) => r.id === user.rep!.id) ?? null) : null;
  const requested = query.rep ? (roster.find((r) => r.slug === query.rep) ?? null) : null;
  const filterRep = director ? requested : ownRep;
  /** True when a non-director has no rep row: every figure must read zero. */
  const blind = !director && !ownRep;
  const leadRepId = blind ? NOBODY_REP_ID : (filterRep?.id ?? null);
  const repSlug = filterRep?.slug ?? null;

  // The same window one year back, day for day.
  const lyFrom = lastYearYmd(window.from);
  const lyUntil = lastYearYmd(window.until);
  const lyYear = window.year - 1;

  const [
    thisWindow,
    lastWindow,
    bookedDays,
    bookedDaysLy,
    monthsThis,
    monthsLast,
    goals,
    sources,
    funnelRaw,
    lost,
    response,
    prevResponse,
    hosts,
    reachOuts,
    deposits,
  ] = await Promise.all([
    eventWindowRollup({ from: window.from, until: window.until, locationId }),
    eventWindowRollup({ from: lyFrom, until: lyUntil, locationId }),
    bookedByDayRollup({ from: window.from, until: window.until, locationId }),
    bookedByDayRollup({ from: lyFrom, until: lyUntil, locationId }),
    monthlyRollup(window.year, locationId),
    monthlyRollup(lyYear, locationId),
    listGoalsForYear(window.year),
    leadsBySource({
      from: window.from,
      until: window.until,
      repId: leadRepId,
      centre,
    }),
    funnelByStatus({
      from: window.from,
      until: window.until,
      repId: leadRepId,
      centre,
    }),
    lostReasons({ from: window.from, until: window.until, repId: leadRepId, centre }),
    responseMinutes({
      from: window.from,
      until: window.until,
      repId: leadRepId,
      centre,
    }),
    responseMinutes({
      from: lastYearYmd(window.from),
      until: lastYearYmd(window.until),
      repId: leadRepId,
      centre,
    }),
    lastYearHostCounts({ from: lyFrom, until: lyUntil, locationId }),
    reachOutCount({ from: window.from, until: window.until }),
    depositsDue({ ...depositWindow(now), centerCode }),
  ]);

  // ---- attribute the mirror rollups -------------------------------------
  const coverage = emptyCoverage();
  const perRep = new Map<string, Totals>();
  const teamTotals = zeroTotals();
  for (const row of thisWindow) {
    const match = index.match(row.clientKey, row.responsibleUserId, row.responsibleName);
    for (let i = 0; i < row.projects; i++) countCoverage(coverage, match.kind);
    addRollup(teamTotals, row);
    if (!match.rep) continue;
    const t = perRep.get(match.rep.id) ?? zeroTotals();
    addRollup(t, row);
    perRep.set(match.rep.id, t);
  }

  const perRepLy = new Map<string, Totals>();
  const teamLy = zeroTotals();
  for (const row of lastWindow) {
    const match = index.match(row.clientKey, row.responsibleUserId, row.responsibleName);
    addRollup(teamLy, row);
    if (!match.rep) continue;
    const t = perRepLy.get(match.rep.id) ?? zeroTotals();
    addRollup(t, row);
    perRepLy.set(match.rep.id, t);
  }

  // ---- pacing -----------------------------------------------------------
  // ONE scope predicate for every mirror-derived chart. A `null` filterRep
  // means "everyone", which is right for a director on the team view and wrong
  // for a rep with no roster row — hence the explicit `blind` arm, so the
  // pacing line and the monthly bars cannot show the team's money to somebody
  // the roster has never heard of.
  const inScope = (row: MirrorRollupRow): boolean => {
    if (blind) return false;
    if (!filterRep) return true;
    return (
      index.match(row.clientKey, row.responsibleUserId, row.responsibleName).rep?.id ===
      filterRep.id
    );
  };

  const byDay = dayMap(bookedDays, inScope);
  const lyByDay = dayMap(bookedDaysLy, inScope);
  // LY's cumulative must be read on the SAME day-of-window, so its map is keyed
  // by this year's day through `dayPairs` inside `pacingFor`.
  const goalForWindow = blind ? 0 : goalCentsFor(goals, window, filterRep);
  const pacing = pacingFor(
    { from: window.from, days: window.days, elapsed: window.elapsed },
    byDay,
    lyByDay,
    goalForWindow,
  );

  // ---- per-rep rows -----------------------------------------------------
  // A rep with no roster row shows NOTHING, never the roster: `blind` is the
  // only branch that yields an empty list, and the screen says why.
  const shown = blind ? [] : filterRep ? [filterRep] : roster;
  const reps: RepKpi[] = shown.map((rep) => {
    const t = perRep.get(rep.id) ?? zeroTotals();
    const ly = perRepLy.get(rep.id) ?? zeroTotals();
    return {
      repId: rep.id,
      slug: rep.slug,
      firstName: rep.firstName,
      displayName: rep.displayName,
      initials: rep.initials,
      bookedCents: t.bookedCents,
      lastYearToDateCents: proRata(ly.bookedCents, window),
      lastYearFullCents: ly.bookedCents,
      quotedCents: t.quotedCents,
      goalCents: goalCentsFor(goals, window, rep),
      leads: t.leads,
      confirmed: t.confirmed,
    };
  });

  // The TEAM tile is the team's only when a director is looking at the team.
  // For anybody scoped to one rep — by their own role, or by a director's
  // filter — it is that rep's row, so the tiles and the table agree.
  const teamTile: RepKpi = {
    ...emptyRepKpi(null, "team", "All salespeople"),
    bookedCents: teamTotals.bookedCents,
    lastYearToDateCents: lastYearOnSameDay(pacing),
    lastYearFullCents: teamLy.bookedCents,
    quotedCents: teamTotals.quotedCents,
    goalCents: goalForWindow,
    leads: teamTotals.leads,
    confirmed: teamTotals.confirmed,
  };
  const team: RepKpi = blind
    ? emptyRepKpi(null, "none", user.name || user.email)
    : filterRep
      ? (reps[0] ?? emptyRepKpi(filterRep, filterRep.slug, filterRep.displayName))
      : teamTile;
  if (filterRep) team.lastYearToDateCents = lastYearOnSameDay(pacing);

  return {
    window,
    centre,
    repSlug,
    reps,
    // The picker's options. Built from the ROSTER, never from `reps`, which
    // narrows to the filtered person — see `roster` in contracts.ts.
    roster: (blind ? [] : roster).map((r) => ({
      slug: r.slug,
      firstName: r.firstName,
      displayName: r.displayName,
    })),
    team,
    pacing,
    funnel: toFunnel(funnelRaw),
    bySource: sources.map((s) => ({
      source: s.source,
      label: sourceLabel(s.source),
      leads: s.leads,
      won: s.won,
    })),
    lostReasons: lost satisfies LostRow[],
    monthly: monthlyRows(monthsThis, monthsLast, goals, inScope, filterRep, window.year, now),
    deposits: { ...deposits, days: DEPOSIT_WINDOW_DAYS } satisfies DepositsDue,
    reachOuts: { done: reachOuts, hosts: hosts.hosts, remaining: hosts.remaining },
    medianResponseMinutes: median(response.minutes),
    previousMedianResponseMinutes: median(prevResponse.minutes),
    leadSources: sources.map((s) => ({
      source: s.source,
      label: sourceLabel(s.source),
      leads: s.leads,
      won: s.won,
    })),
    // Coverage describes the rows that FED these figures. A rep scoped to
    // their own row was never shown the unattributed ones, so reporting the
    // team's gap to them would be a number about data they cannot see.
    attribution: (blind ? emptyCoverage() : coverage) satisfies AttributionCoverage,
  };
}

export const DEPOSIT_WINDOW_DAYS = 30;

function depositWindow(now: Date): { from: string; until: string } {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [y, m, d] = today.split("-").map(Number);
  const end = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1, 12) + DEPOSIT_WINDOW_DAYS * 86_400_000);
  const until = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, "0")}-${String(
    end.getUTCDate(),
  ).padStart(2, "0")}`;
  return { from: today, until };
}

/** Day → confirmed cents booked that day, for whoever `inScope` admits. */
function dayMap(
  rows: MirrorRollupRow[],
  inScope: (row: MirrorRollupRow) => boolean,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (bucketOf(row.stateName) !== "confirmed") continue;
    if (!inScope(row)) continue;
    const key = row.day ?? "";
    if (!key) continue;
    out.set(key, (out.get(key) ?? 0) + row.cents);
  }
  return out;
}

function lastYearOnSameDay(pacing: { points: { lyCents: number }[]; todayDay: number }): number {
  if (pacing.todayDay <= 0) return 0;
  return pacing.points[pacing.todayDay - 1]?.lyCents ?? 0;
}

/**
 * Last year's figure at the SAME point of the window, when no pacing series is
 * available for that rep — a straight pro-rata of the finished total by days
 * elapsed. Used only for the per-rep rows; the team tile reads the real
 * cumulative off the pacing series.
 */
function proRata(fullCents: number, window: KpiWindow): number {
  if (window.days === 0) return 0;
  return Math.round((fullCents * Math.min(window.elapsed, window.days)) / window.days);
}

function goalCentsFor(
  goals: { repId: string | null; month: number; goalCents: number }[],
  window: KpiWindow,
  rep: CrmRep | null,
): number {
  return goals
    .filter((g) => window.months.includes(g.month) && (rep ? g.repId === rep.id : true))
    .reduce((a, g) => a + g.goalCents, 0);
}

function toFunnel(
  rows: { statusId: string; label: string; kind: string; count: number; valueCents: number }[],
): FunnelRow[] {
  return rows.map((r) => ({
    statusId: r.statusId,
    label: r.label,
    count: r.count,
    valueCents: r.valueCents,
  }));
}

function monthlyRows(
  thisYear: MirrorRollupRow[],
  lastYear: MirrorRollupRow[],
  goals: { repId: string | null; month: number; goalCents: number }[],
  inScope: (row: MirrorRollupRow) => boolean,
  filterRep: CrmRep | null,
  year: number,
  now: Date,
): MonthlyGoalRow[] {
  const actual = new Map<number, number>();
  const ly = new Map<number, number>();
  const add = (into: Map<number, number>, rows: MirrorRollupRow[]) => {
    for (const row of rows) {
      if (bucketOf(row.stateName) !== "confirmed") continue;
      if (!inScope(row)) continue;
      const m = row.month ?? 0;
      if (!m) continue;
      into.set(m, (into.get(m) ?? 0) + row.cents);
    }
  };
  add(actual, thisYear);
  add(ly, lastYear);

  return Array.from({ length: 12 }, (_, i) => {
    const month = i + 1;
    const w = monthWindow(year, month, now);
    const started = elapsedDays(w.from, w.until, now) > 0;
    return {
      month,
      label: monthShort(month),
      goalCents: goals
        .filter((g) => g.month === month && (filterRep ? g.repId === filterRep.id : true))
        .reduce((a, g) => a + g.goalCents, 0),
      lastYearCents: ly.get(month) ?? 0,
      actualCents: started ? (actual.get(month) ?? 0) : null,
    };
  });
}

export type { DayPair, OfficeClientKey };
