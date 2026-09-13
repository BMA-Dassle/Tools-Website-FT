import { z } from "zod";
import { writeAudit } from "~/features/crm/core/data/audit-db";
import { withCrmRoute } from "~/features/crm/core/http";
import { ensureCrmSchema } from "~/features/crm/core/schema";
import { JOB_KINDS } from "~/features/crm/core/types";
import { runJobInline } from "~/features/crm/jobs";

/**
 * POST /api/admin/crm/jobs/run — director only (wire contract, brief §3.9).
 * `{kind, payload?}` → `{ok, job: JobRow, result}`.
 *
 * Runs ONE handler inline, in-request: this is how previews are smoked, since
 * `verifyCron` short-circuits every cron on a preview. `kind:"noop"` returns
 * `{ok:true, actor_email, ranAt}`; `kind:"seed"` runs the idempotent seed and
 * returns its counts. A kind whose PR has not landed comes back with
 * `job.status:"failed"` and `result.ok:false` — a 200, never a 500.
 *
 * `maxDuration = 60`: a handler may legitimately take longer than the default
 * function timeout (R15).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  kind: z.enum(JOB_KINDS),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const POST = withCrmRoute(
  Body,
  async ({ input, user }) => {
    await ensureCrmSchema();
    const { job, result } = await runJobInline({
      kind: input.kind,
      payload: input.payload,
      actorEmail: user.email,
    });
    await writeAudit({
      entity: "job",
      entityId: job.id,
      action: `run:${input.kind}`,
      actorEmail: user.email,
      after: { status: job.status, attempts: job.attempts, result },
    });
    return { job, result };
  },
  { director: true },
);
