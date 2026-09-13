/**
 * React Query keys for the calls sub (brief §3.4: `["crm", <sub>, …]` tuples;
 * mutations invalidate `callsKeys.all`). CLIENT-SAFE — no imports. Components
 * import this file by path, never the sub's server barrel.
 */

export const callsKeys = {
  all: ["crm", "calls"] as const,
  list: (filters: Record<string, string> = {}) => ["crm", "calls", "list", filters] as const,
  badges: () => ["crm", "calls", "badges"] as const,
};

export type CallsKey =
  | typeof callsKeys.all
  | ReturnType<(typeof callsKeys)["list"]>
  | ReturnType<(typeof callsKeys)["badges"]>;

/** Polling cadence while the tab is visible (`refetchIntervalInBackground: false`). */
export const CALLS_POLL_MS = 30_000;
export const CALL_BADGES_POLL_MS = 60_000;
