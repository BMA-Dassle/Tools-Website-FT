/** `~/features/crm/jobs` — the retry table, the registry and the runner. */
export {
  BACKOFF_STEP_SECONDS,
  MAX_BACKOFF_SECONDS,
  backoffSeconds,
  ensureJobsSchema,
  isJobKind,
  mapJobRow,
  neonJobStore,
  planFailure,
  type EnqueueInput,
  type FailurePlan,
  type JobRowRaw,
  type JobStore,
} from "./data/jobs-db";
export {
  HANDLERS,
  NOT_IMPLEMENTED_ERROR,
  RUNNABLE_JOB_KINDS,
  noopHandler,
  notImplemented,
  seedHandler,
  type JobContext,
  type JobHandler,
  type JobOutcome,
} from "./registry";
export {
  DEFAULT_BATCH,
  DEFAULT_DEADLINE_MS,
  DEFAULT_LEASE_SECONDS,
  defaultRunnerDeps,
  drainDueJobs,
  runJobInline,
  runLeasedJob,
  type DrainOptions,
  type DrainOutcome,
  type DrainSummary,
  type RunInlineInput,
  type RunResult,
  type RunnerDeps,
} from "./runner";
export {
  SCHEDULED_KINDS,
  enqueueScheduled,
  type ScheduledEnqueue,
  type ScheduledKind,
} from "./scheduled";
