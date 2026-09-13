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
export {
  SALES_DIRECTOR_ROLE,
  SALES_ROLE,
  crmRoleFromRoles,
  crmUserFromRequest,
  isDirector,
  normalizeEmail,
  publicRep,
  publicUser,
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
export { ensureCrmSchema } from "./schema";
