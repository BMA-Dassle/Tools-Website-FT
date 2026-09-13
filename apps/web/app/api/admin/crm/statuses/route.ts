import { z } from "zod";
import { CENTRE_LIST } from "~/features/crm/core/centres";
import type { CentreSummary } from "~/features/crm/core/contracts";
import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import { STATUS_KINDS } from "~/features/crm/core/types";
import {
  STATUS_ID_RE,
  archiveStatus,
  getStatus,
  listStatusMap,
  listStatuses,
  reorderStatuses,
  upsertStatus,
} from "~/features/crm/statuses";

/**
 * /api/admin/crm/statuses (wire contract)
 *   GET            → `{ok, statuses, map, centres}` — the Statuses screen's one read.
 *   POST director  `{action:"upsert", status}` | `{action:"reorder", ids}` | `{action:"archive", id}`
 *                  → `{ok, statuses, map}`; every action writes `crm_audit`.
 *
 * `centres` is the CENTRE → clientKey summary so the screen can say "Fort
 * Myers (both centres)" next to a `headpinzftmyers` mapping.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const StatusId = z.string().regex(STATUS_ID_RE, "expected a lowercase slug");

const StatusInput = z.object({
  id: StatusId,
  label: z.string().trim().min(1).max(60),
  kind: z.enum(STATUS_KINDS),
  position: z.number().int().min(1).max(500).optional(),
  slaLabel: z.string().trim().max(80).nullable().optional(),
  slaHours: z
    .number()
    .int()
    .min(0)
    .max(24 * 365)
    .nullable()
    .optional(),
  onBoard: z.boolean().optional(),
});

const PostBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("upsert"), status: StatusInput }),
  z.object({ action: z.literal("reorder"), ids: z.array(StatusId).min(1).max(50) }),
  z.object({ action: z.literal("archive"), id: StatusId }),
]);

function centres(): CentreSummary[] {
  return CENTRE_LIST.map((c) => ({
    code: c.code,
    name: c.name,
    short: c.short,
    clientKey: c.clientKey,
  }));
}

export const GET = withCrmRoute(z.object({}), async () => {
  const [statuses, map] = await Promise.all([listStatuses(), listStatusMap()]);
  return { statuses, map, centres: centres() };
});

export const POST = withCrmRoute(
  PostBody,
  async ({ input, user }) => {
    if (input.action === "upsert") {
      const before = await getStatus(input.status.id);
      const after = await upsertStatus(input.status);
      await writeAudit({
        entity: "status",
        entityId: after.id,
        action: before ? "update" : "create",
        actorEmail: user.email,
        before,
        after,
      });
    } else if (input.action === "reorder") {
      const before = (await listStatuses({ includeArchived: true })).map((s) => s.id);
      await reorderStatuses(input.ids);
      await writeAudit({
        entity: "status",
        entityId: "*",
        action: "reorder",
        actorEmail: user.email,
        before,
        after: input.ids,
      });
    } else {
      const before = await getStatus(input.id);
      if (!before) throw new CrmHttpError(404, "status_not_found");
      const archived = await archiveStatus(input.id);
      if (archived) {
        await writeAudit({
          entity: "status",
          entityId: input.id,
          action: "archive",
          actorEmail: user.email,
          before,
          after: await getStatus(input.id),
        });
      }
    }
    const [statuses, map] = await Promise.all([listStatuses(), listStatusMap()]);
    return { statuses, map };
  },
  { director: true },
);
