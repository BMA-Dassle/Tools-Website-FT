/**
 * `~/features/crm/rules` — the assignment engine, the rules table, the roster
 * (7shifts mirror + manual overrides) and the assign sweep (B2).
 *
 * Stable names other subs and the follow-up wiring stage rely on:
 *   assignDecision(lead, ctx)        the pure engine
 *   loadEngineContext(centre, now)   builds ctx from reps / rules / shifts / open volume
 *   runAssignSweep(deps)             the sweep body (B3's assign plugs into `applyDecisions`)
 *   sevenShiftsMirrorHandler / assignSweepHandler   the two job handlers
 *
 * Server-only modules (Neon, env) live here; client components import
 * `./contracts`, `./labels` and `./queries` by path.
 */

export {
  ensureRulesSchema,
  getRule,
  insertRule,
  listRules,
  mapRuleRow,
  reorderRules,
  seedRules,
  setRuleEnabled,
  updateRule,
  type RuleInput,
  type RuleRowRaw,
  type RuleSeed,
} from "./data/rules-db";
export {
  ensureShiftsSchema,
  lastSevenShiftsSyncAt,
  listShiftsForDates,
  mapShiftRow,
  pruneSevenShifts,
  setOffToday,
  upsertSevenShifts,
  type OffTodayInput,
  type PruneInput,
  type SevenShiftUpsert,
  type ShiftRowRaw,
} from "./data/shifts-db";
export {
  listSweepCandidates,
  loadOpenVolumeByRepMonth,
  type SweepCandidate,
} from "./data/volume-db";
export {
  fmtHour,
  fmtWindow,
  isOffToday,
  nextStart,
  onShiftNow,
  rosterForDate,
  rosterFromShiftRows,
  rosterReps,
  rosterStatus,
  type NextStart,
  type RosterByRep,
  type RosterClock,
  type RosterDay,
  type RosterStatus,
  type RosterStatusKind,
  type RosterWindow,
  type ShiftRow,
  type ShiftWindow,
} from "./service/availability";
export {
  activeRules,
  assignDecision,
  autoPick,
  candidateReps,
  monthLabel,
  standardPick,
  volumeFor,
  whenMatches,
  type DecisionOutcome,
  type EngineContext,
  type EngineDecision,
  type EngineLead,
  type VolumeByRepMonth,
  type VolumeCell,
} from "./service/engine";
export { loadEngineContext, rosterDates, type LoadedEngineContext } from "./service/context";
export {
  SEVEN_SHIFTS_API_VERSION,
  SEVEN_SHIFTS_DEFAULT_COMPANY_ID,
  SEVEN_SHIFTS_GAP_MS,
  SEVEN_SHIFTS_TOKEN_MISSING,
  SEVEN_SHIFTS_USER_AGENT,
  SevenShiftsClient,
  SevenShiftsError,
  isLiveShift,
  isSevenShiftsConfigured,
  sevenShiftsConfig,
  shiftsQuery,
  toSevenShift,
  type SevenShift,
  type SevenShiftRaw,
  type SevenShiftsClientDeps,
  type SevenShiftsConfig,
  type SevenShiftsUserRaw,
} from "./service/sevenshifts";
export {
  mirrorLocations,
  mirrorSevenShifts,
  repsBySevenShiftsUserId,
  shiftsToUpserts,
  type MirrorClient,
  type MirrorDeps,
  type MirrorLocationSummary,
  type MirrorStore,
  type MirrorSummary,
} from "./service/mirror";
export {
  SWEEP_BUSINESS_HOURS,
  SWEEP_HELD_REASON,
  SWEEP_NOT_APPLIED_REASON,
  isAfterHours,
  mirrorIdempotencyKey,
  runAssignSweep,
  sweepIdempotencyKey,
  type SweepDecision,
  type SweepDeps,
  type SweepResult,
} from "./service/sweep";
export { assignSweepHandler, sevenShiftsMirrorHandler } from "./service/jobs";
export { nowLabel, rosterDateLabel, ruleCode, toDecisionWire, toRosterRows } from "./service/wire";
export {
  CentreCodeSchema,
  RULE_KINDS,
  RosterPostBodySchema,
  RosterQuerySchema,
  RuleInputSchema,
  RuleThenSchema,
  RuleWhenSchema,
  RulesPostBodySchema,
  TryLeadQuerySchema,
  type RosterPostBodyParsed,
  type RuleInputParsed,
  type RulesPostBodyParsed,
  type TryLeadQuery,
} from "./schemas";
export * from "./contracts";
export { EVENT_TYPE_LABEL, LEAD_SOURCE_LABEL, RULE_KIND_CHIP } from "./labels";
export { rulesKeys } from "./queries";
