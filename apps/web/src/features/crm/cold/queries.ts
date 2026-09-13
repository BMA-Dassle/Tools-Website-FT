/**
 * React Query keys for the cold sub (brief §3.4: `["crm", <sub>, …]` tuples;
 * mutations invalidate `coldKeys.all`). CLIENT-SAFE — no imports. Components
 * import this file by path, never the sub's server barrel (§5.7b).
 */

export const coldKeys = {
  all: ["crm", "cold"] as const,
  lists: (filters: Record<string, string> = {}) => ["crm", "cold", "lists", filters] as const,
  list: (id: string, filters: Record<string, string> = {}) =>
    ["crm", "cold", "list", id, filters] as const,
};

export type ColdKey =
  | typeof coldKeys.all
  | ReturnType<(typeof coldKeys)["lists"]>
  | ReturnType<(typeof coldKeys)["list"]>;

/** Polling cadence while the tab is visible (`refetchIntervalInBackground: false`). */
export const COLD_POLL_MS = 60_000;
