import { z } from "zod";
import { isCentreCode } from "~/features/crm/core/centres";
import { withCrmRoute } from "~/features/crm/core/http";
import type { CentreCode } from "~/features/crm/core/types";
import { listOfficeStateNames } from "~/features/crm/statuses";

/**
 * GET /api/admin/crm/statuses/office-states?centre=HPFM|FT|HPN (wire contract)
 * → `{ok, centre, clientKey, source: "office"|"unavailable", error?, states, proposals}`.
 *
 * Reads Office metadata through the precision-safe transport and proposes
 * `crm_status_bmi_map` rows BY NAME; ids are never invented. When Office
 * cannot be reached the answer is still 200 with `source:"unavailable"` and
 * the error text, so the screen renders the seed with an "unmapped" badge.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Query = z.object({
  centre: z.string().refine(isCentreCode, "expected HPFM, FT or HPN"),
});

export const GET = withCrmRoute(Query, async ({ input }) => {
  const r = await listOfficeStateNames(input.centre as CentreCode);
  return {
    centre: r.centre,
    clientKey: r.clientKey,
    source: r.source,
    ...(r.error ? { error: r.error } : {}),
    states: r.states,
    proposals: r.proposals,
  };
});
