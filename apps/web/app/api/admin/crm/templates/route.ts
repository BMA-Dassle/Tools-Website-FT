import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import { archiveTemplate, listTemplates, upsertTemplate } from "~/features/crm/collateral";
import { listRoster } from "~/features/crm/reps";
import {
  TemplatesPostSchema,
  TemplatesQuerySchema,
  UnknownConversationError,
  loadConversation,
  loadRenderedTemplates,
  renderTemplate,
  toGsm7,
} from "~/features/crm/sms";
import { crmSmsEnabled } from "~/features/crm/core/flags";

/**
 * /api/admin/crm/templates — the message templates a rep picks from.
 *
 *   GET  ?kind=sms|email&key=<conversation>&centre → `{ok, templates}`
 *        Rendered for that person when `key` is given: merge fields filled from
 *        the contact / lead / rep, tokens we cannot fill LEFT VISIBLE and
 *        listed in `missing` (never silently blank), and SMS bodies normalised
 *        to GSM-7 so the picker shows what will actually go out.
 *   POST {action:"upsert"|"archive", …} → `{ok, templates}` — director only.
 *        An SMS body that is still outside GSM-7 after normalising is REFUSED
 *        (R11 `assertGsm7Safe`): a template is written once and sent hundreds
 *        of times, so the check belongs at the point it is saved.
 *
 * Guest-facing copy lives in `crm_templates`, never in a component (R11).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(TemplatesQuerySchema, async ({ input, user }) => {
  if (!input.key) {
    const templates = await listTemplates({ kind: input.kind, centre: input.centre ?? null });
    const ctx = {
      contact: null,
      lead: null,
      rep: user.rep ? { firstName: user.rep.firstName } : null,
    };
    return { templates: templates.map((t) => renderTemplate(t, ctx)) };
  }
  try {
    const detail = await loadConversation({
      key: input.key,
      rep: user.rep,
      reps: await listRoster(),
      smsEnabled: crmSmsEnabled(),
      limit: 1,
    });
    const templates = await loadRenderedTemplates({
      kind: input.kind,
      centre: input.centre ?? null,
      contact: detail.contact,
      lead: detail.lead,
      rep: user.rep ? { firstName: user.rep.firstName } : null,
    });
    return { templates };
  } catch (err) {
    if (err instanceof UnknownConversationError) {
      throw new CrmHttpError(404, "conversation_not_found");
    }
    throw err;
  }
});

export const POST = withCrmRoute(
  TemplatesPostSchema,
  async ({ input, user }) => {
    if (input.action === "archive") {
      const archived = await archiveTemplate(input.id, user.email);
      if (!archived) throw new CrmHttpError(404, "template_not_found");
      await writeAudit({
        entity: "template",
        entityId: input.id,
        action: "archive",
        actorEmail: user.email,
        before: { name: archived.name, kind: archived.kind },
      });
      return { templates: await listTemplates() };
    }

    const t = input.template;
    let body = t.body;
    if (t.kind === "sms") {
      const gsm = toGsm7(body, `crm-template-${t.name}`);
      if (!gsm.ok) {
        throw new CrmHttpError(
          400,
          `not_gsm7: remove ${JSON.stringify(gsm.offending)} - plain ASCII only`,
        );
      }
      body = gsm.body;
    }
    const saved = await upsertTemplate(
      {
        id: t.id ?? null,
        kind: t.kind,
        name: t.name,
        subject: t.subject ?? null,
        body,
        centre: t.centre ?? null,
        position: t.position,
      },
      user.email,
    );
    if (!saved) throw new CrmHttpError(404, "template_not_found");
    await writeAudit({
      entity: "template",
      entityId: saved.id,
      action: t.id ? "update" : "create",
      actorEmail: user.email,
      after: { name: saved.name, kind: saved.kind, mergeFields: saved.mergeFields },
    });
    return { templates: await listTemplates() };
  },
  { director: true },
);
