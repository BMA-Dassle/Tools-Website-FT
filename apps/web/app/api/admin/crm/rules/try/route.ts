import { withCrmRoute } from "~/features/crm/core/http";
import { shiftYmd, todayEasternYmd } from "~/features/crm/core/dates";
import {
  TryLeadQuerySchema,
  assignDecision,
  loadEngineContext,
  nowLabel,
  toDecisionWire,
} from "~/features/crm/rules";

/**
 * GET /api/admin/crm/rules/try?guests=&type=&centre=[&eventDate=&kids=&source=]
 * → `{ok, lead, decision, now, nowLabel}` — the Rules screen's "Try a lead"
 * (crm-shared.js:445-448): the SAME engine, the SAME context the sweep would
 * load right now, for a hypothetical lead. Read-only. `eventDate` defaults to
 * ET today + 30 days so the party-month volume has something to balance on.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(TryLeadQuerySchema, async ({ input }) => {
  const now = new Date();
  const eventDate = input.eventDate ?? shiftYmd(todayEasternYmd(now), 30);
  const ctx = await loadEngineContext(input.centre, now);
  const lead = {
    guests: input.guests,
    type: input.type,
    centre: input.centre,
    eventDate,
    kids: input.kids,
    source: input.source,
  };
  const decision = assignDecision(lead, ctx);
  return {
    lead,
    decision: toDecisionWire(decision, ctx.rules),
    now: now.toISOString(),
    nowLabel: nowLabel(now),
  };
});
