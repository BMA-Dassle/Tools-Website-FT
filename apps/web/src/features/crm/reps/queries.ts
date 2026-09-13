/**
 * React Query keys for the roster (brief §3.4: `["crm", <sub>, …]` tuples).
 * CLIENT-SAFE — no imports. Components import this file by path
 * (`~/features/crm/reps/queries`), never the sub's server barrel.
 */

export const repsKeys = {
  all: ["crm", "reps"] as const,
  list: (filter: { includeInactive?: boolean; role?: string } = {}) =>
    ["crm", "reps", "list", filter] as const,
  me: ["crm", "me"] as const,
};

export type RepsKey =
  | ReturnType<(typeof repsKeys)["list"]>
  | typeof repsKeys.all
  | typeof repsKeys.me;
