/**
 * `~/features/crm/core` — the vocabulary every sub imports.
 *
 * SERVER-SAFE AND CLIENT-SAFE SPLIT: `identity`, `http` and `schema` pull in
 * `@/auth`, `next/server` and `@ft/db`, so client components import the pure
 * modules by path (`~/features/crm/core/contracts`, `/nav`, `/screens`,
 * `/format`, `/dates`, `/types`, `/centres`) and never this barrel. Route
 * handlers and server components may use the barrel.
 */

export * from "./types";
export * from "./contracts";
export * from "./centres";
export * from "./flags";
export * from "./nav";
export * from "./screens";
export * from "./format";
export * from "./dates";
export * from "./projections";
export {
  SALES_DIRECTOR_ROLE,
  SALES_ROLE,
  crmRoleFromRoles,
  crmUserFromRequest,
  isDirector,
  normalizeEmail,
  requireCrmUser,
  type CrmUserResolution,
} from "./identity";
export {
  CrmHttpError,
  apiError,
  json,
  notFoundText,
  withCrmRoute,
  type CrmRouteContext,
  type CrmRouteHandler,
  type CrmRouteOptions,
  type RouteArgs,
  type RouteParams,
} from "./http";
export { CRM_TABLES, ensureCrmSchema } from "./schema";
export { runSeed, type SeedCounts } from "./seed";
export * from "./settings";
export {
  ensureSettingsSchema,
  getCrmSettings,
  getSettingValue,
  listSettingRows,
  putCrmSetting,
  type SettingRow,
} from "./data/settings-db";
export {
  ensureAuditSchema,
  listAudit,
  writeAudit,
  type AuditEntry,
  type AuditRow,
} from "./data/audit-db";
