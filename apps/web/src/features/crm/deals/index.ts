/**
 * `~/features/crm/deals` — ONE RECORD, THREE LENSES (BUILD-BRIEF §B.15).
 *
 * The BMI project is the spine; `crm_leads` and `group_function_quotes` are
 * overlays. Pipeline, Contracts and Events import this barrel and differ only
 * in the scope and window they ask for.
 *
 * SERVER-ONLY: `service/*` and `data/*` pull in Neon. Client components import
 * `./contracts` by path for the types.
 */

export * from "./contracts";
export * from "./schemas";
export {
  ALL_STATE_STATUS,
  LOST_STATE_STATUS,
  OFFICE_ID_ALIASES,
  OFFICE_NAME_ALIASES,
  OPEN_STATE_STATUS,
  WON_STATE_STATUS,
  buildRepIndex,
  leadOf,
  projectOf,
  quoteOf,
  repFromProject,
  repRefOf,
  statusFromBmiState,
  toDeal,
  type DealRowRaw,
  type RepIndex,
  type RepMatchRow,
  type ToDealContext,
} from "./projection";
export {
  DEAL_CENTER_CODE,
  DEAL_EVENT_DATE,
  DEAL_FROM,
  DEAL_SELECT,
  ONLINE_KIND_ID,
  binder,
  buildDealQuery,
  buildKeyCte,
  countDealRows,
  dealWhere,
  queryDealRows,
  repClause,
  searchClause,
  type Binder,
  type DealQueryOptions,
  type RepFilterKeys,
} from "./data/deals-db";
export {
  listDeals,
  loadRepIndex,
  repFilterKeys,
  repWhere,
  type ListDealsOptions,
} from "./service/list";
export { ensureDealSchemas } from "./transport";
