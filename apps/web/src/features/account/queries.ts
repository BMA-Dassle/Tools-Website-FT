/**
 * React Query key factory for the account feature. Tuples (not strings) so
 * partial-match invalidation works. Mirrors features/booking/queries.ts.
 */
export const accountKeys = {
  all: ["account"] as const,
  me: ["account", "me"] as const,
  subscriptions: ["account", "subscriptions"] as const,
};
