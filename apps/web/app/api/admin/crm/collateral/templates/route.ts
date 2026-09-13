import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import {
  MERGE_FIELDS,
  getTemplate,
  gsm7Verdict,
  listTemplates,
  reorderTemplates,
  setTemplateArchived,
  upsertTemplate,
} from "~/features/crm/collateral";
import { GSM7_ERROR } from "~/features/crm/collateral/service/merge";
import { TemplatesListQuery, TemplatesPostSchema } from "~/features/crm/collateral/schemas";

/**
 * /api/admin/crm/collateral/templates
 *   GET            ?kind&centre&archived → `{ok, templates, mergeFields}`
 *   POST director  `{action:"upsert"|"archive"|"restore"|"reorder"}` → `{ok, templates, template?}`
 *
 * GSM-7 IS ENFORCED HERE, not only in the editor (R11). An SMS body with a
 * character outside 7-bit ASCII silently halves the segment length (70 instead
 * of 160) and doubles what every send costs, and the editor is not the only
 * caller a template will ever have — C1's composer reads these rows. So an SMS
 * upsert carrying a non-GSM-7 character is refused 422 `not_gsm7` with the
 * offending character in the message, and `gsm7` rides on every SMS row that
 * is read back so the list can flag one that is already stored.
 *
 * That is not hypothetical: the seeded "Quote nudge (48 h)" (PR1's
 * `core/seed.ts` T-2, copied verbatim from the prototype) contains an em dash.
 * It is visible in the list as a warning from the first render, and it cannot
 * be saved again until the character is replaced.
 *
 * `mergeFields` ships with the list so the editor's insert buttons and the
 * preview's sample values come from ONE definition (`service/merge.ts`) rather
 * than a copy in the component.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function payload(kind?: "sms" | "email" | null, centre?: string | null, archived?: boolean) {
  const templates = await listTemplates({
    kind: kind ?? null,
    centre: (centre as never) ?? null,
    includeArchived: archived === true,
  });
  return { templates, mergeFields: MERGE_FIELDS.map((f) => ({ ...f })) };
}

export const GET = withCrmRoute(TemplatesListQuery, async ({ input }) =>
  payload(input.kind ?? null, input.centre ?? null, input.archived === "1"),
);

export const POST = withCrmRoute(
  TemplatesPostSchema,
  async ({ input, user }) => {
    if (input.action === "upsert") {
      const t = input.template;
      if (t.kind === "sms") {
        const verdict = gsm7Verdict(t.body);
        if (!verdict.ok) {
          throw new CrmHttpError(
            422,
            `${GSM7_ERROR}: ${JSON.stringify(verdict.offending)} is not GSM-7 — texts with it cost double`,
          );
        }
      }
      const before = t.id ? await getTemplate(t.id) : null;
      if (t.id && !before) throw new CrmHttpError(404, "template_not_found");
      const template = await upsertTemplate({
        id: t.id ?? null,
        kind: t.kind,
        name: t.name,
        subject: t.kind === "email" ? (t.subject ?? null) : null,
        body: t.body,
        centre: t.centre ?? null,
        position: t.position ?? null,
        actorEmail: user.email,
      });
      await writeAudit({
        entity: "template",
        entityId: template.id,
        action: before ? "update" : "create",
        actorEmail: user.email,
        before,
        after: template,
      });
      return { ...(await payload()), template };
    }

    if (input.action === "reorder") {
      const before = (await listTemplates()).map((t) => t.id);
      await reorderTemplates(input.ids, user.email);
      await writeAudit({
        entity: "template",
        entityId: "*",
        action: "reorder",
        actorEmail: user.email,
        before,
        after: input.ids,
      });
      return payload();
    }

    const archived = input.action === "archive";
    const before = await getTemplate(input.id);
    if (!before) throw new CrmHttpError(404, "template_not_found");
    const template = await setTemplateArchived(input.id, archived, user.email);
    await writeAudit({
      entity: "template",
      entityId: input.id,
      action: archived ? "archive" : "restore",
      actorEmail: user.email,
      before,
      after: template,
    });
    return { ...(await payload()), ...(template ? { template } : {}) };
  },
  { director: true },
);
