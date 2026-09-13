import { z } from "zod";
import { OFFICE_CLIENT_KEYS } from "~/features/crm/core/centres";
import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import { STATUS_ID_RE, getStatus, listStatusMap, upsertStatusMap } from "~/features/crm/statuses";
import type { OfficeClientKey } from "~/features/crm/core/types";

/**
 * POST /api/admin/crm/statuses/map — director only (wire contract).
 * `{statusId, clientKey, bmiStateId, bmiStateName}` → `{ok, map}`.
 *
 * The state id is whatever the director confirmed from the office-states
 * list (or typed by hand); it is stored as TEXT and never parsed as a number.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  statusId: z.string().regex(STATUS_ID_RE, "expected a lowercase slug"),
  clientKey: z
    .string()
    .refine(
      (v) => (OFFICE_CLIENT_KEYS as readonly string[]).includes(v),
      "expected an Office clientKey",
    ),
  bmiStateId: z
    .string()
    .trim()
    .regex(/^-?\d{1,18}$/, "expected an Office state id"),
  bmiStateName: z.string().trim().min(1).max(120),
});

export const POST = withCrmRoute(
  Body,
  async ({ input, user }) => {
    const status = await getStatus(input.statusId);
    if (!status) throw new CrmHttpError(404, "status_not_found");
    const { before, after } = await upsertStatusMap({
      statusId: input.statusId,
      clientKey: input.clientKey as OfficeClientKey,
      bmiStateId: input.bmiStateId,
      bmiStateName: input.bmiStateName,
    });
    await writeAudit({
      entity: "status_bmi_map",
      entityId: `${input.statusId}:${input.clientKey}`,
      action: before ? "update" : "create",
      actorEmail: user.email,
      before,
      after,
    });
    return { map: await listStatusMap() };
  },
  { director: true },
);
