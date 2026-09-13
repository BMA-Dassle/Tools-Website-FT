import { z } from "zod";
import { withCrmRoute } from "~/features/crm/core/http";
import { JOB_STATUSES } from "~/features/crm/core/types";
import { neonJobStore } from "~/features/crm/jobs";

/**
 * GET /api/admin/crm/jobs?status=pending|running|done|failed|parked[&limit=]
 * → `{ok, jobs: JobRow[]}` (wire contract). Newest first, ≤ 200. The director's
 * "Needs attention" tile reads `status=parked`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Query = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const GET = withCrmRoute(Query, async ({ input }) => ({
  jobs: await neonJobStore.list({ status: input.status, limit: input.limit }),
}));
