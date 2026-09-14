/**
 * React Query keys for the measure sub (brief §3.4: `["crm", <sub>, …]` tuples).
 * CLIENT-SAFE — no imports at all. Components import this file BY PATH, never
 * through `~/features/crm/kpi` (§5.7b: a sub barrel drags the Redis client into
 * the browser bundle and fails the Vercel build).
 */

export const measureKeys = {
  all: ["crm", "measure"] as const,
  kpi: (q: Record<string, string | null | undefined>) => ["crm", "measure", "kpi", q] as const,
  accountability: (q: Record<string, string | null | undefined>) =>
    ["crm", "measure", "accountability", q] as const,
  goals: (year: number) => ["crm", "measure", "goals", year] as const,
  targets: () => ["crm", "measure", "targets"] as const,
};
