import {
  BuilderTemplatesPostSchema,
  BuilderTemplatesQuerySchema,
  archiveQuoteTemplate,
  insertQuoteTemplate,
  listQuoteTemplates,
} from "~/features/crm/bmi";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import { writeAudit } from "~/features/crm/core";

/**
 * `/api/admin/crm/builder/templates` — reusable quote packages (C5).
 *
 * GET  `?centre=HPFM` — that centre's templates plus every "all centres" one,
 *      most-used first. `uses` rides along so a package nobody has sold in a
 *      year is visibly a package nobody has sold in a year, which is what
 *      sales asked to be able to see.
 *
 * POST `{action:"save"}`   — save the quote on screen as a template.
 *      `{action:"archive"}` — retire one. A soft delete: a template a quote was
 *      built from is history, and history is not deleted.
 *
 * NO PRICE IS EVER STORED. A template holds `{productId, per?, min?}` — what
 * and how many. How much comes from `projectProduct/price` for the event's own
 * date, every time the template is applied, because weekday and weekend are
 * different numbers and a frozen price is wrong the day the catalogue moves.
 *
 * WRITES NOTHING TO OFFICE. Applying a template does (through `POST /builder`);
 * saving one is Neon alone, so this route is not gated on `CRM_BMI_WRITES`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(BuilderTemplatesQuerySchema, async ({ input }) => ({
  templates: await listQuoteTemplates(input.centre ?? null),
}));

export const POST = withCrmRoute(BuilderTemplatesPostSchema, async ({ input, user }) => {
  if (input.action === "archive") {
    const archived = await archiveQuoteTemplate(input.id);
    if (!archived) throw new CrmHttpError(404, "template_not_found");
    await writeAudit({
      entity: "crm_quote_template",
      entityId: input.id,
      action: "template.archive",
      actorEmail: user.email,
    });
    return { templates: await listQuoteTemplates(null) };
  }

  const template = await insertQuoteTemplate({
    name: input.name,
    centre: input.centre ?? null,
    baselineGuests: input.baselineGuests,
    description: input.description ?? null,
    lines: input.lines,
    createdBy: user.email,
  });
  await writeAudit({
    entity: "crm_quote_template",
    entityId: template.id,
    action: "template.save",
    actorEmail: user.email,
    after: { name: template.name, lines: template.lines.length },
  });

  return { templates: await listQuoteTemplates(input.centre ?? null) };
});
