/**
 * React Query keys for the pipeline board (brief §3.4: `["crm", <sub>, …]`
 * tuples; mutations invalidate the sub's root key). CLIENT-SAFE — no imports.
 * Components import this file by path, never the sub's server barrel (§5.7b).
 */

export const pipelineKeys = {
  all: ["crm", "pipeline"] as const,
  board: (filters: Record<string, string> = {}) => ["crm", "pipeline", "board", filters] as const,
};

export type PipelineKey = typeof pipelineKeys.all | ReturnType<(typeof pipelineKeys)["board"]>;

/** Poll cadence while the tab is visible (`refetchIntervalInBackground: false`). */
export const PIPELINE_POLL_MS = 45_000;
