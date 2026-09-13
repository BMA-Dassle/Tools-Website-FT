/**
 * The wire contract for the three MEASURE screens (C7) — KPI dashboard,
 * Accountability and the Goals editor. Kept beside the sub, like
 * `rules/contracts.ts`, so parallel PRs never race on one file's tail.
 *
 * Dependency-free apart from types; ids are strings; a `"use client"`
 * component may import it BY PATH (§5.7b: a screen never imports its sub's
 * `index.ts` — that drags ioredis and `dns` into the browser bundle).
 *
 * MONEY ON THIS PAGE HAS THREE DIFFERENT MEANINGS and the old portal dashboard
 * conflated them. Every figure below names which one it is, and the screens
 * print the same sentences where the owner can read them (`REVENUE_BASIS`):
 *
 *   bmi      — `crm_bmi_projects.total_value_cents`, the Office project's own
 *              total value. The ONLY basis with like-for-like history back
 *              years, so every "vs last year" number on the page is this one.
 *              It is what the centre BOOKED, not what anybody has paid.
 *   contract — `group_function_quotes.total_cents`, the signed contract total.
 *              Exists only once a contract has been raised, so it can never
 *              carry a last-year comparison — used for contract counts and the
 *              money still to collect.
 *   square   — what Square actually captured: the deposit at signing plus the
 *              balance at T-72h (`deposit_paid_at` / `balance_paid_at`). Cash,
 *              not bookings.
 */

import type { ApiOk, PublicRep } from "~/features/crm/core/contracts";
import type { CentreCode } from "~/features/crm/core/types";

// ---------------------------------------------------------------------------
// Which money is this?
// ---------------------------------------------------------------------------

export type RevenueBasis = "bmi" | "contract" | "square" | "count" | "minutes";

/** The sentence a tile's tooltip shows, keyed by basis. Rendered, not summarised. */
export const REVENUE_BASIS: Record<RevenueBasis, string> = {
  bmi: "BMI project value (Office totalValue) — what the centre booked, not what has been paid.",
  contract: "Signed contract total (group_function_quotes.total_cents) — no last-year twin exists.",
  square: "Money Square actually captured — deposit at signing plus balance at T-72h.",
  count: "A count of records, not money.",
  minutes: "Elapsed minutes, not money.",
};

/** The footnote the KPI screen prints under the page (prototype's last line). */
export const KPI_FOOTNOTE =
  "Booked = BMI project value in Confirmation states · Quoted = BMI project value in Quote / " +
  "Send Contract · Deposits and balances = Square, through the contract rail. " +
  "Every tile names its own basis in its tooltip.";

// ---------------------------------------------------------------------------
// Buckets (brief §1.10 — the portal's own definitions, reproduced)
// ---------------------------------------------------------------------------

export type KpiBucket = "confirmed" | "quoted" | "lead";

// ---------------------------------------------------------------------------
// GET /api/admin/crm/kpi?month=YYYY-MM | quarter=YYYY-Qn [&rep=&centre=]
// ---------------------------------------------------------------------------

/** How a mirrored project was matched to a rep; `fuzzy` is a NAME match (§1.10). */
export type AttributionKind = "exact" | "fuzzy" | "none";

export interface AttributionCoverage {
  projects: number;
  exact: number;
  fuzzy: number;
  none: number;
}

/** One salesperson's month. Every `*Cents` figure is basis `bmi` unless named. */
export interface RepKpi {
  repId: string | null;
  slug: string;
  firstName: string;
  displayName: string;
  initials: string;
  /** Booked: CONFIRMED projects in the window, BMI totalValue. */
  bookedCents: number;
  /** Same window one year back, BMI totalValue — the "vs LY" denominator. */
  lastYearToDateCents: number;
  /** The whole of last year's matching window, BMI totalValue. */
  lastYearFullCents: number;
  /** QUOTED projects in the window, BMI totalValue. */
  quotedCents: number;
  /** `crm_goals` for the window (Σ across centres when no centre filter). */
  goalCents: number;
  /** Leads created in the window (crm_leads), a count. */
  leads: number;
  /** Leads that reached a won status in the window, a count. */
  confirmed: number;
}

/** One point of the cumulative pacing series. `ty` is null for days not yet reached. */
export interface PacingPoint {
  /** Day of the window, 1-based. */
  day: number;
  /** YYYY-MM-DD in ET. */
  date: string;
  /** Cumulative booked cents this year, or null beyond today. */
  tyCents: number | null;
  /** Cumulative booked cents in the same window one year back. */
  lyCents: number;
}

export interface PacingSeries {
  points: PacingPoint[];
  /** Index (1-based day) of the last day with a `ty` value; 0 when none. */
  todayDay: number;
  goalCents: number;
  /** Whole days in the window. */
  days: number;
}

export interface FunnelRow {
  statusId: string;
  label: string;
  count: number;
  /** Open value of the leads in that status, basis `bmi` via the mirror join. */
  valueCents: number;
}

export interface SourceRow {
  source: string;
  label: string;
  leads: number;
  won: number;
}

export interface LostRow {
  reason: string;
  n: number;
}

export interface MonthlyGoalRow {
  /** 1-12 */
  month: number;
  /** "Jan" */
  label: string;
  goalCents: number;
  /** Last year's actual for that month, basis `bmi`. */
  lastYearCents: number;
  /** This year's actual, basis `bmi`; null for a month not yet started. */
  actualCents: number | null;
}

/** Money still to collect on events inside the window — basis `square`/`contract`. */
export interface DepositsDue {
  /** Balance + unpaid deposit still outstanding, in cents (basis `square`). */
  outstandingCents: number;
  /** Events with a contract in the window. */
  events: number;
  /** Of those, contracts with nothing signed yet. */
  unsigned: number;
  /** Days ahead the window covers (30). */
  days: number;
}

export interface ReachOutProgress {
  /** Reach-out activities logged in the window. */
  done: number;
  /** Hosts in the same window one year back (the denominator). */
  hosts: number;
  /** Hosts with no 2026 lead yet. */
  remaining: number;
}

export interface KpiWindow {
  /** "2026-09" or "2026-Q4". */
  key: string;
  /** "September 2026" / "Oct – Dec 2026". */
  label: string;
  /** Inclusive ET calendar days. */
  from: string;
  until: string;
  days: number;
  /** Days of the window already elapsed in ET (0 for a future window). */
  elapsed: number;
  year: number;
  /** The months the window spans, 1-12. */
  months: number[];
}

export type KpiResponse = ApiOk<{
  window: KpiWindow;
  /** Null when no centre filter is applied. */
  centre: CentreCode | null;
  /** The rep filter, or null for the whole team. */
  repSlug: string | null;
  /** Per-salesperson rows (one row when a rep filter is on). */
  reps: RepKpi[];
  /** The same fields summed across `reps`. */
  team: RepKpi;
  pacing: PacingSeries;
  funnel: FunnelRow[];
  bySource: SourceRow[];
  lostReasons: LostRow[];
  monthly: MonthlyGoalRow[];
  deposits: DepositsDue;
  reachOuts: ReachOutProgress;
  /** Median minutes from `created_at` to `first_touch_at`; null with no data. */
  medianResponseMinutes: number | null;
  /** The previous window's median, for the tile's delta line. */
  previousMedianResponseMinutes: number | null;
  /** Leads created in the window, split by source (the tile's sub-line). */
  leadSources: SourceRow[];
  attribution: AttributionCoverage;
}>;

// ---------------------------------------------------------------------------
// GET /api/admin/crm/accountability?range=week|last|4w[&rep=]
// ---------------------------------------------------------------------------

export type AccountabilityRange = "week" | "last" | "4w";

export const ACCOUNTABILITY_RANGES: readonly AccountabilityRange[] = ["week", "last", "4w"];

export interface WeeklyTarget {
  calls: number;
  texts: number;
  emails: number;
  reachouts: number;
  responseTargetMinutes: number;
  /** YYYY-MM-DD the row applies from; null when the defaults are in play. */
  effectiveFrom: string | null;
}

export interface WeeklyActual {
  calls: number;
  texts: number;
  emails: number;
  reachouts: number;
  /** Distinct leads touched in the range. */
  leadsTouched: number;
  /** Median minutes to first outbound touch for leads assigned in the range. */
  medianResponseMinutes: number | null;
  /** Calls per week over the last four weeks, oldest first — the sparkline. */
  trend: number[];
}

export interface RepAccountability {
  repId: string;
  slug: string;
  firstName: string;
  displayName: string;
  initials: string;
  target: WeeklyTarget;
  actual: WeeklyActual;
}

export interface AccountabilityWindow {
  range: AccountabilityRange;
  /** Inclusive ET calendar days. */
  from: string;
  until: string;
  /** "Week of Sep 7 – 13". */
  label: string;
  /** Whole ET days left in the range, 0 once it is over. */
  workingDaysLeft: number;
  /** How many weeks the range covers (targets are scaled by this). */
  weeks: number;
}

export type AccountabilityResponse = ApiOk<{
  window: AccountabilityWindow;
  /** One row for a rep; the whole assignable roster for a director. */
  reps: RepAccountability[];
  /** Director-only: the rep furthest behind, for the banner. Null when none is. */
  behind: {
    slug: string;
    displayName: string;
    callsPct: number;
    reachoutsPct: number;
    medianResponseMinutes: number | null;
    responseTargetMinutes: number;
  } | null;
}>;

/** The rep's own weekly strip on My Day (`direction-b.html:98`). */
export type MyWeekResponse = ApiOk<{
  window: AccountabilityWindow;
  rep: RepAccountability | null;
}>;

// ---------------------------------------------------------------------------
// GET / POST /api/admin/crm/targets — director writes
// ---------------------------------------------------------------------------

export interface TargetsPostBody {
  repSlug: string;
  calls: number;
  texts: number;
  emails: number;
  reachouts: number;
  responseTargetMinutes: number;
  /** YYYY-MM-DD; the service defaults to next Monday in ET. */
  effectiveFrom?: string;
}

export type TargetsResponse = ApiOk<{
  targets: { repSlug: string; target: WeeklyTarget }[];
  reps: PublicRep[];
}>;

// ---------------------------------------------------------------------------
// GET / POST /api/admin/crm/goals — director writes, mirrored to Pandora
// ---------------------------------------------------------------------------

export interface GoalCell {
  repSlug: string;
  year: number;
  month: number;
  goalCents: number;
  /** Last year's actual for that rep and month, basis `bmi`. */
  lastYearCents: number;
  /** This year's actual so far, basis `bmi`; null for a month not yet started. */
  actualCents: number | null;
  /** When the per-rep TOTAL was last mirrored to Pandora; null = never. */
  pandoraSyncedAt: string | null;
}

/** A queued or failed `pandora-goals-sync`, surfaced on the Goals screen. */
export interface GoalMirrorState {
  repSlug: string;
  year: number;
  status: "pending" | "running" | "done" | "failed" | "parked";
  attempts: number;
  lastError: string | null;
  /** ISO instant the row was last touched. */
  updatedAt: string;
}

export type GoalsResponse = ApiOk<{
  year: number;
  reps: PublicRep[];
  cells: GoalCell[];
  /** Suggested = last year × this factor (the prototype's banner). */
  suggestFactor: number;
  /** Queued / failed Pandora mirrors — never swallowed (brief C7). */
  mirror: GoalMirrorState[];
  /** False when the signed-in person may not edit (everyone but a director). */
  canEdit: boolean;
}>;

export interface GoalInput {
  repSlug: string;
  year: number;
  month: number;
  goalCents: number;
}

export interface GoalsPostBody {
  goals: GoalInput[];
}

export type GoalsPostResponse = ApiOk<{
  year: number;
  cells: GoalCell[];
  mirror: GoalMirrorState[];
  /** Reps whose Pandora mirror was queued by this save. */
  queued: string[];
  /** Set when the mirror ran inline and failed — shown, never swallowed. */
  mirrorError: string | null;
}>;

/** The `payload` of `POST /jobs/run {kind:"pandora-goals-sync"}`. */
export interface PandoraGoalsJobPayload {
  repSlug: string;
  year: number;
}

/** What that job puts in `result`. */
export interface PandoraGoalsRunSummary {
  ok: boolean;
  repSlug: string;
  salesName: string;
  year: number;
  /** One entry per month actually sent. */
  months: { month: number; goalDollars: number; salesGoalId: string | null }[];
  skipped: string | null;
}

// ---------------------------------------------------------------------------
// DOM test ids
// ---------------------------------------------------------------------------

export const MEASURE_TEST_IDS = {
  kpi: "crm-kpi",
  kpiTiles: "crm-kpi-tiles",
  kpiRange: "crm-kpi-range",
  pacing: "crm-kpi-pacing",
  pacingTable: "crm-kpi-pacing-table",
  funnel: "crm-kpi-funnel",
  byRep: "crm-kpi-by-rep",
  bySource: "crm-kpi-by-source",
  lost: "crm-kpi-lost",
  monthly: "crm-kpi-monthly",
  footnote: "crm-kpi-footnote",
  accountability: "crm-accountability",
  accountabilityRange: "crm-accountability-range",
  repCard: (slug: string) => `crm-accountability-rep-${slug}`,
  teamTable: "crm-accountability-team",
  targetsSheet: "crm-targets-sheet",
  goals: "crm-goals",
  goalsTable: "crm-goals-table",
  goalsSave: "crm-goals-save",
  goalsMirror: "crm-goals-mirror",
  goalInput: (slug: string, month: number) => `crm-goal-${slug}-${month}`,
} as const;
