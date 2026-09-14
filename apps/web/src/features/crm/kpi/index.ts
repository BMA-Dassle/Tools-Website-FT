/**
 * `~/features/crm/kpi` — the measure sub: KPI dashboard, Accountability, the
 * Goals editor and the weekly targets behind them.
 *
 * A SERVER-SIDE BARREL. Route handlers and the jobs registry import it; a
 * `"use client"` component MUST NOT (§5.7b) — `data/*-db.ts` reaches `@ft/db`
 * and the jobs store reaches ioredis, and one barrel import drags `dns`/`net`
 * into the browser bundle and kills the Turbopack build. Screens import the
 * pure modules by path instead: `~/features/crm/kpi/contracts` and
 * `~/features/crm/kpi/queries`.
 */

export { ensureTargetsSchema, DEFAULT_TARGET, BUCKET_DEFAULT_TARGET } from "./data/targets-db";
export { ensureGoalsSchema } from "./data/goals-db";
export { ensureMeasureReadable } from "./data/measure-db";

export {
  accountability,
  measurableRoster,
  myWeek,
  pctOf,
  visibleRoster,
  worstBehind,
  type AccountabilityQuery,
} from "./service/accountability";
export { kpiDashboard, sourceLabel, DEPOSIT_WINDOW_DAYS, type KpiQuery } from "./service/kpi";
export { goalsGrid, goalReps, mirrorState, saveGoals, SUGGEST_FACTOR } from "./service/goals";
export { listTargets, nextMondayEt, saveTarget } from "./service/targets";
export { pandoraGoalsSyncHandler } from "./service/jobs";
export {
  goalDollars,
  goalsSyncKey,
  pushRepGoals,
  putPandoraGoal,
  PandoraGoalsError,
  PANDORA_MIN_YEAR,
  PANDORA_URL,
  type GoalsPushDeps,
} from "./service/pandora-goals";
export {
  bucketOf,
  conversionRate,
  isCancelledState,
  isConfirmedState,
  isDoubleCounted,
  isLeadState,
  isQuotedState,
  normalizeBmiStateName,
} from "./service/buckets";
export {
  buildAttributionIndex,
  officeUserIdFor,
  OFFICE_USER_IDS,
  type AttributionIndex,
} from "./service/attribution";
export {
  accountabilityWindow,
  monthWindow,
  quarterWindow,
  resolveKpiWindow,
  trailingWeeks,
} from "./service/windows";
