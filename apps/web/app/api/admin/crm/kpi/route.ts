/**
 * `GET /api/admin/crm/kpi?month=YYYY-MM|quarter=YYYY-Qn&rep=&centre=` (C7).
 *
 * Thin by design (brief §3.4): zod → `withCrmRoute`'s auth chain → the service.
 * No role branch here — `kpiDashboard` takes the signed-in user and narrows a
 * rep to their own numbers itself, so the enforcement lives with the query that
 * would otherwise leak, not in a route that a later caller could bypass.
 */

import { withCrmRoute } from "~/features/crm/core/http";
import { KpiQuerySchema } from "~/features/crm/kpi/schemas";
import { kpiDashboard } from "~/features/crm/kpi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(KpiQuerySchema, async ({ input, user }) =>
  kpiDashboard(user, {
    month: input.month ?? null,
    quarter: input.quarter ?? null,
    rep: input.rep ?? null,
    centre: input.centre ?? null,
  }),
);
