/**
 * React Query keys for the Collateral screen (brief §3.4: `["crm", <sub>, …]`
 * tuples; a mutation invalidates the sub's root key).
 *
 * CLIENT-SAFE — no imports at all, so components reach it by path
 * (`~/features/crm/collateral/queries`) and never drag the sub's server
 * barrel, Neon or `@vercel/blob` into a browser bundle.
 */

export interface CollateralListFilterKey {
  centre?: string | null;
  tag?: string | null;
  q?: string | null;
  archived?: boolean;
}

export const collateralKeys = {
  all: ["crm", "collateral"] as const,
  list: (filter: CollateralListFilterKey = {}) => ["crm", "collateral", "list", filter] as const,
  item: (id: string) => ["crm", "collateral", "item", id] as const,
  templates: (kind?: string | null) => ["crm", "collateral", "templates", kind ?? "all"] as const,
  shares: (scope: { collateralId?: string | null; lead?: string | null }) =>
    ["crm", "collateral", "shares", scope] as const,
};
