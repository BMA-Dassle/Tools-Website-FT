/**
 * React Query keys for the contracts sub (brief §3.4: `["crm", <sub>, …]`
 * tuples; mutations invalidate `contractsKeys.all`). CLIENT-SAFE — no imports.
 * Components import this file by path, never the sub's server barrel: the
 * barrel drags Neon, Square and the Office client into the browser bundle and
 * the build dies (`feat/crm-availability` @ fbfc8a7, §5.7b).
 */

export const contractsKeys = {
  all: ["crm", "contracts"] as const,
  list: (filters: Record<string, string> = {}) => ["crm", "contracts", "list", filters] as const,
  counts: () => ["crm", "contracts", "counts"] as const,
  detail: (shortId: string) => ["crm", "contracts", "detail", shortId] as const,
  payments: (shortId: string) => ["crm", "contracts", "payments", shortId] as const,
  history: (shortId: string) => ["crm", "contracts", "history", shortId] as const,
  /** The live BMI public notes behind "what the guest sees". */
  notes: (shortId: string) => ["crm", "contracts", "notes", shortId] as const,
};

export type ContractsKey =
  | typeof contractsKeys.all
  | ReturnType<(typeof contractsKeys)["list"]>
  | ReturnType<(typeof contractsKeys)["counts"]>
  | ReturnType<(typeof contractsKeys)["detail"]>
  | ReturnType<(typeof contractsKeys)["payments"]>
  | ReturnType<(typeof contractsKeys)["history"]>
  | ReturnType<(typeof contractsKeys)["notes"]>;

/** The badge poll cadence, while the tab is visible. */
export const CONTRACT_BADGES_POLL_MS = 60_000;
