import { isDirector } from "~/features/crm/core/identity";
import { withCrmRoute } from "~/features/crm/core/http";
import { DealsQuerySchema } from "~/features/crm/deals/schemas";
// By path, not through the barrel: the deals service pulls in Neon and the
// three subs that own the joined tables.
import { listDeals } from "~/features/crm/deals/service/list";

/**
 * `GET /api/admin/crm/deals?scope=&from=&until=&centre=&rep=&q=`
 *   → `{ok, deals, total, spineCounts}`
 *
 * THE ONE READ. A deal is a BMI project with two overlays — the `crm_leads`
 * row saying who is working it, and the `group_function_quotes` row saying what
 * the money is doing. Pipeline, Contracts and Events are three FILTERS over
 * this, which is the whole point of "one record, three lenses"
 * (BUILD-BRIEF §B.15).
 *
 * SCOPE, not visibility: a rep sees the whole board the same way a director
 * does, because a planner needs to know an event exists even when it is not
 * theirs. What a rep cannot do is act on someone else's deal, and that is
 * enforced where the ACTION is, not by hiding rows here. A rep with no `?rep=`
 * is defaulted to their own slug so their first view is their own work.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const truthy = (v: string | undefined) => v === "1" || v === "true";

export const GET = withCrmRoute(DealsQuerySchema, async ({ input, user }) => {
  const director = isDirector(user);
  // A rep lands on their own work; a director sees the team unless they pick
  // somebody. Neither is a permission boundary — it is a starting view.
  const repSlug = input.rep ?? (director ? null : (user.rep?.slug ?? null));

  const { deals, total } = await listDeals({
    scope: input.scope,
    from: input.from ?? null,
    until: input.until ?? null,
    centre: input.centre ?? null,
    repSlug,
    q: input.q ?? null,
    excludeProspects: truthy(input.excludeProspects),
    limit: input.limit,
    offset: input.offset,
    withTotal: truthy(input.withTotal),
  });

  // Which table gave each deal its identity. A screen can SHOW the gap — a
  // contract whose project we have not mirrored, a lead whose mint has not
  // landed — rather than us writing a row to make the list look complete.
  const spineCounts = deals.reduce<Record<string, number>>((acc, d) => {
    acc[d.spine] = (acc[d.spine] ?? 0) + 1;
    return acc;
  }, {});

  return { deals, total, spineCounts, repSlug };
});
