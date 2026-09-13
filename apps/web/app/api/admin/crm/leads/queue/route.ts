import { withCrmRoute } from "~/features/crm/core/http";
import { EmptySchema, loadQueue } from "~/features/crm/leads";

/**
 * GET /api/admin/crm/leads/queue — director only.
 *   → `{ok, unassigned: QueueLead[], reps: QueueRepColumn[], months, autoAssignInMinutes, sweepDelayMinutes}`
 *
 * Every unassigned lead carries `suggestion` and `trace` from `suggestFor`
 * (null / [] until the rules engine is wired — the AssignSheet then shows
 * "No auto-pick yet").
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(EmptySchema, async () => loadQueue(), { director: true });
