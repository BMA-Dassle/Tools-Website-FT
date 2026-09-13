/**
 * `GET|POST /api/admin/crm/goals?year=` (C7) — the Goals editor.
 *
 * GET is open to anybody with a sales role: the grid carries `canEdit`, and a
 * rep reading their own goal alongside last year's actual is the point of the
 * screen. POST is `{director: true}` at the route AND re-checked in the
 * service, so a job or a script cannot write goals by not being HTTP.
 *
 * The save order is the service's, and it is the reason this route is thin:
 * Neon first, then a durable `crm_jobs` retry row, then a best-effort inline
 * run so the owner sees the Pandora answer now. A failed mirror comes back as
 * `mirrorError` and is shown beside the year — never swallowed, and never able
 * to lose what the owner typed.
 */

import { withCrmRoute } from "~/features/crm/core/http";
import { GoalsPostSchema, GoalsQuerySchema } from "~/features/crm/kpi/schemas";
import { goalsGrid, saveGoals } from "~/features/crm/kpi";
import { todayEasternYmd } from "~/features/crm/core/dates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function currentYear(): number {
  return Number(todayEasternYmd().slice(0, 4));
}

export const GET = withCrmRoute(GoalsQuerySchema, async ({ input, user }) =>
  goalsGrid(user, input.year ?? currentYear()),
);

export const POST = withCrmRoute(
  GoalsPostSchema,
  async ({ input, user }) => saveGoals(user, { goals: input.goals }),
  { director: true },
);
