import {
  ActivityPostSchema,
  SNOOZE_PRESETS,
  TimelineQuerySchema,
  buildTimeline,
  listLeadTimeline,
  touchesFrom,
} from "~/features/crm/activities";
// `service/actions` is imported by path, not through the sub's barrel — it
// calls `transition()`, which imports this sub back (see `statuses/index.ts`).
import { addNote, logCall, snoozeLead } from "~/features/crm/activities/service/actions";
import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import { getLead, leadNumericId } from "~/features/crm/leads";

/**
 * /api/admin/crm/leads/[id]/activities
 *   GET  ?cursor=&limit=  → `{ok, activities, nextCursor, touchesToday}`
 *                           keyset on (occurred_at, id) DESC (R10, never OFFSET)
 *   POST {kind:"note"|"snooze"|"call", …} → `{ok, activity, lead, countedAsTouch}`
 *
 * A NOTE IS NEVER WRITTEN TO BMI (R6) — it lands in `crm_activities` and
 * nowhere else. BMI's own private and public notes are the Notes tab's job.
 *
 * `countedAsTouch` is the prototype's accountability rule made real
 * (crm-shared.js:418): a touch counts once per lead per channel per ET day.
 * The activity is ALWAYS recorded; only the score is deduped, so the timeline
 * still shows a rep's third call of the day.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function leadIdFrom(params: Record<string, string | string[]>): string {
  const raw = Array.isArray(params.id) ? params.id[0] : params.id;
  const id = raw ? leadNumericId(raw) : null;
  if (!id) throw new CrmHttpError(404, "lead_not_found");
  return id;
}

export const GET = withCrmRoute(TimelineQuerySchema, async ({ input, params }) => {
  const id = leadIdFrom(params);
  const lead = await getLead(id);
  if (!lead) throw new CrmHttpError(404, "lead_not_found");
  const page = buildTimeline(
    await listLeadTimeline(lead.id, { limit: input.limit ?? 100, cursor: input.cursor ?? null }),
  );
  return {
    activities: page.activities,
    nextCursor: page.nextCursor,
    // The newest page always covers today, so the tally needs no second query.
    touchesToday: touchesFrom(page.activities, new Date()),
  };
});

export const POST = withCrmRoute(ActivityPostSchema, async ({ input, params, user }) => {
  const id = leadIdFrom(params);
  const lead = await getLead(id);
  if (!lead) throw new CrmHttpError(404, "lead_not_found");

  const result =
    input.kind === "note"
      ? await addNote({ lead, body: input.body, actor: user.email })
      : input.kind === "snooze"
        ? await snoozeLead({
            lead,
            preset: input.preset,
            label: SNOOZE_PRESETS.find((p) => p.id === input.preset)?.label ?? input.preset,
            actor: user.email,
          })
        : await logCall({
            lead,
            outcome: input.outcome,
            note: input.note ?? null,
            durationSeconds: input.durationSeconds ?? null,
            actor: user.email,
          });

  await writeAudit({
    entity: "lead",
    entityId: lead.id,
    action: `activity:${input.kind}`,
    actorEmail: user.email,
    before: { status: lead.status, nextAction: lead.nextAction },
    after: { status: result.lead.status, nextAction: result.lead.nextAction },
  });

  return {
    activity: result.activity,
    lead: result.lead,
    countedAsTouch: result.countedAsTouch,
  };
});
