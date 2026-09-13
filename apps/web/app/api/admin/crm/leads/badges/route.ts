import { withCrmRoute } from "~/features/crm/core/http";
import { EmptySchema, loadBadges } from "~/features/crm/leads";

/**
 * GET /api/admin/crm/leads/badges → `{ok, overdue, unassigned}`
 *
 * The sidebar / bottom-tab badge provider for My Day (overdue — mine for a
 * rep, the team's for a director) and the Lead queue (unassigned; 0 for a
 * rep, who cannot open the queue anyway). Polled while the tab is visible.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(EmptySchema, async ({ user }) => loadBadges(user));
