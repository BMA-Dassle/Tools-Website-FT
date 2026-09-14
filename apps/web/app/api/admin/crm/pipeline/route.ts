import { isDirector } from "~/features/crm/core/identity";
import { listReps } from "~/features/crm/reps";
import { withCrmRoute } from "~/features/crm/core/http";
import { PipelineQuerySchema } from "~/features/crm/statuses";
// By path, not through the barrel: `service/pipeline` imports the leads sub,
// which imports the statuses barrel back (see `statuses/index.ts`).
import { loadPipeline } from "~/features/crm/statuses/service/pipeline";

/**
 * GET /api/admin/crm/pipeline?by=rep&centre=&q=&mine=
 *   → `{ok, columns, leads, statuses, reps, openCount, openValueCents, byRep, truncated}`
 *
 * The columns are the on-board `crm_statuses` in position order, plus the two
 * synthetic buckets the prototype appends — Booked (every won status) and
 * Closed (every lost one). Each column carries its lead ids, its count and the
 * Σ of `value_cents` the header shows.
 *
 * SCOPE: a rep sees their own leads, a director the team's. `?mine=1` lets a
 * director look at their own; `?by=rep` turns the columns into swimlanes and is
 * refused for a rep, because a rep's board only ever holds one lane.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const truthy = (v: string | undefined) => v === "1" || v === "true";

export const GET = withCrmRoute(PipelineQuerySchema, async ({ input, user }) => {
  const director = isDirector(user);
  const mine = truthy(input.mine) || !director;
  // A director may narrow the team board to one salesperson. A rep cannot —
  // `mine` is already forced on for them above, so `?rep=` can only ever
  // NARROW a director's view, never widen anybody's.
  const pickedRep =
    director && !mine && input.rep
      ? ((await listReps()).find((r) => r.slug === input.rep && r.active) ?? null)
      : null;
  const repId = mine ? (user.rep?.id ?? null) : (pickedRep?.id ?? null);
  // Swimlanes and a one-person filter answer the same question; the filter wins.
  const byRep = director && !mine && !pickedRep && input.by === "rep";

  const data = await loadPipeline({
    scope: mine || pickedRep ? "mine" : "team",
    repId,
    byRep,
    centre: input.centre,
    q: input.q,
  });

  return {
    columns: data.columns,
    leads: data.leads,
    statuses: data.statuses,
    reps: data.reps,
    openCount: data.openCount,
    openValueCents: data.openValueCents,
    byRep: data.byRep,
    truncated: data.truncated,
  };
});
