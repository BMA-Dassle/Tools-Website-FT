/**
 * `GET /api/admin/crm/accountability?range=week|last|4w&rep=&mine=1` (C7).
 *
 * `mine=1` is the My Day strip: this week, this person, nothing else. Both
 * shapes go through the same service, which narrows the roster to what the
 * signed-in person may see BEFORE it reads a single activity row — a rep
 * cannot reach a colleague's counts by editing `?rep=`.
 */

import { withCrmRoute } from "~/features/crm/core/http";
import { AccountabilityQuerySchema } from "~/features/crm/kpi/schemas";
import { accountability, myWeek } from "~/features/crm/kpi";
import type { AccountabilityRange } from "~/features/crm/kpi/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(AccountabilityQuerySchema, async ({ input, user }) => {
  if (input.mine === "1") return myWeek(user);
  return accountability(user, {
    range: (input.range as AccountabilityRange | undefined) ?? null,
    rep: input.rep ?? null,
  });
});
