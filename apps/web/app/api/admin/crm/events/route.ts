import { EventsBoardQuerySchema, eventsBoard, resolveBoardDate } from "~/features/crm/events";
import { withCrmRoute } from "~/features/crm/core/http";

/**
 * GET /api/admin/crm/events?centre=HPFM&view=week&date=2026-09-16&cancelled=1
 *   → `{ok, centre, view, date, today, includeCancelled, days[]}`
 *
 * The Events board's ONE read: BMI truth per day through `listDailyEvents`
 * (the same 360 s `de:res:*` cache the v2 Daily Events board reads, reached
 * through that function and never by key), merged with `group_function_quotes`
 * for the money pill and `crm_leads` for the owner.
 *
 * Read-only. Cancelled events are hidden unless `cancelled=1`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(EventsBoardQuerySchema, async ({ input }) => ({
  ...(await eventsBoard({
    centre: input.centre,
    view: input.view ?? "week",
    date: resolveBoardDate(input.date, new Date()),
    includeCancelled: input.cancelled === "1" || input.cancelled === "true",
  })),
}));
