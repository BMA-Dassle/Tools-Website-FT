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

/**
 * The builder's keys (C5). Every mutation invalidates `builderKeys.all`, which
 * is deliberately coarse: a line write moves the balance, the office-only list,
 * the sync state and the lines themselves, and re-reading one without the
 * others is how a screen ends up showing a total that disagrees with its own
 * rows.
 *
 * The catalogue key carries the DATE because the price does.
 */
export const builderKeys = {
  all: ["crm", "builder"] as const,
  state: (leadId: string) => ["crm", "builder", "state", leadId] as const,
  catalog: (centre: string, date: string, q: string) =>
    ["crm", "builder", "catalog", centre, date, q] as const,
  price: (centre: string, date: string, productId: string, quantity: number) =>
    ["crm", "builder", "price", centre, date, productId, quantity] as const,
  templates: (centre: string | null) => ["crm", "builder", "templates", centre ?? "all"] as const,
};

export type BuilderKey =
  | typeof builderKeys.all
  | ReturnType<typeof builderKeys.state>
  | ReturnType<typeof builderKeys.catalog>
  | ReturnType<typeof builderKeys.price>
  | ReturnType<typeof builderKeys.templates>;
