/**
 * Web sales — public surface.
 *
 * `types.ts` is the adapter contract, `adapters/*` teach it about one product
 * each, `registry.ts` says which are live, and `service/*` merges and paginates
 * them. Routes stay thin: parse, authorise, delegate.
 */

export {
  SALE_SOURCE_IDS,
  isSaleSourceId,
  type ExecuteRefundArgs,
  type RefundDestination,
  type RefundPlan,
  type RefundPlanStep,
  type RefundPlanUnit,
  type RefundResult,
  type RefundState,
  type ResendArgs,
  type ResendOutcome,
  type SaleAction,
  type SaleCapability,
  type SaleCursorPosition,
  type SaleDetail,
  type SaleFact,
  type SaleLeg,
  type SaleListQuery,
  type SaleParties,
  type SaleSourceId,
  type SaleSummary,
  type SaleSummaryExtra,
  type SaleTimelineEntry,
  type SaleTone,
  type WebSaleAdapter,
  type WebSaleRow,
} from "./types";

export {
  ActionSchema,
  ListQuerySchema,
  MAX_RANGE_DAYS,
  PreviewSchema,
  RefundDryRunSchema,
  RefundExecuteSchema,
  ResendSchema,
  VoidSchema,
  searchParamsToObject,
  type ActionInput,
  type ListQueryInput,
} from "./schemas";

export { listSaleActions, recordSaleAction, type WebSaleActionKind } from "./data/web-sales-audit-db";

export { adaptersFor, activeAdapters, allAdapters, getAdapter } from "./registry";

export { disabledSaleSources } from "./flags";

export {
  advanceCursor,
  decodeCursor,
  encodeCursor,
  positionFor,
  type SaleCursor,
} from "./service/cursor";

export { compareRowsDesc, listWebSales, mergeRows, type ListWebSalesResult } from "./service/list";

export { EMPTY_SUMMARY, combineSummaries, summarizeWebSales, type SummarizeResult } from "./service/summary";

export { CSV_COLUMNS, csvCell, csvFilename, csvRow, toCsv } from "./service/csv";

export {
  daysBetweenYmd,
  defaultRange,
  easternRangeToUtc,
  shiftYmd,
  todayEasternYmd,
} from "./service/dates";
