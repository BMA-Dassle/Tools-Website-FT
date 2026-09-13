/**
 * `GET|POST /api/admin/crm/targets` (C7) — the weekly activity targets behind
 * every meter on Accountability.
 *
 * GET returns the targets for the roster the caller may see (their own row for
 * a rep, everyone for a director). POST is director-only at the route AND in
 * `saveTarget`, which also refuses an `effective_from` that is not a Monday:
 * a target that starts mid-week moves the bar under somebody who has already
 * worked four days against the old one.
 */

import { withCrmRoute } from "~/features/crm/core/http";
import { TargetsPostSchema, TargetsQuerySchema } from "~/features/crm/kpi/schemas";
import { listTargets, saveTarget } from "~/features/crm/kpi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(TargetsQuerySchema, async ({ user }) => listTargets(user));

export const POST = withCrmRoute(
  TargetsPostSchema,
  async ({ input, user }) =>
    saveTarget(user, {
      repSlug: input.repSlug,
      calls: input.calls,
      texts: input.texts,
      emails: input.emails,
      reachouts: input.reachouts,
      responseTargetMinutes: input.responseTargetMinutes,
      effectiveFrom: input.effectiveFrom,
    }),
  { director: true },
);
