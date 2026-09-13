/**
 * React Query keys for the leads sub (brief §3.4: `["crm", <sub>, …]` tuples;
 * mutations invalidate `leadsKeys.all`). CLIENT-SAFE — no imports. Components
 * import this file by path (`~/features/crm/leads/queries`), never the sub's
 * server barrel.
 */

export const leadsKeys = {
  all: ["crm", "leads"] as const,
  list: (filters: Record<string, string> = {}) => ["crm", "leads", "list", filters] as const,
  detail: (id: string) => ["crm", "leads", "detail", id] as const,
  queue: () => ["crm", "leads", "queue"] as const,
  myDay: () => ["crm", "leads", "my-day"] as const,
  badges: () => ["crm", "leads", "badges"] as const,
};

export type LeadsKey =
  | typeof leadsKeys.all
  | ReturnType<(typeof leadsKeys)["list"]>
  | ReturnType<(typeof leadsKeys)["detail"]>
  | ReturnType<(typeof leadsKeys)["queue"]>
  | ReturnType<(typeof leadsKeys)["myDay"]>
  | ReturnType<(typeof leadsKeys)["badges"]>;

/** Polling cadences while the tab is visible (`refetchIntervalInBackground: false`). */
export const QUEUE_POLL_MS = 30_000;
export const MY_DAY_POLL_MS = 60_000;
export const BADGES_POLL_MS = 60_000;
