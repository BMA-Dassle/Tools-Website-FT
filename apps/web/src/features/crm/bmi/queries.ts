/**
 * React Query keys for the bmi sub's screens (brief §3.4: `["crm", <sub>, …]`
 * tuples; a mutation invalidates the sub's root key). Pure and client-safe —
 * the fetchers live beside the screens in `components/features/crm/history/`.
 */
export const historyKeys = {
  all: ["crm", "history"] as const,
  search: (q: string) => ["crm", "history", "search", q] as const,
  account: (id: string) => ["crm", "history", "account", id] as const,
  lastYear: (clientKey: string | null) =>
    ["crm", "history", "last-year", clientKey ?? "all"] as const,
};

export type HistoryKey =
  | typeof historyKeys.all
  | ReturnType<typeof historyKeys.search>
  | ReturnType<typeof historyKeys.account>
  | ReturnType<typeof historyKeys.lastYear>;
