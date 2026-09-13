/**
 * React Query keys for the rules sub (brief §3.4: `["crm", <sub>, …]` tuples).
 * CLIENT-SAFE — no imports. Components import this file by path.
 */

export const rulesKeys = {
  all: ["crm", "rules"] as const,
  list: () => ["crm", "rules", "list"] as const,
  try: (q: Record<string, string | number | boolean | undefined>) =>
    ["crm", "rules", "try", q] as const,
  roster: (date?: string) => ["crm", "rules", "roster", date ?? "today"] as const,
  gs: () => ["crm", "rules", "gs"] as const,
};
