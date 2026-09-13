import {
  BuilderPostSchema,
  BuilderStateQuerySchema,
  addQuoteLine,
  applyTemplate,
  ensureOfficeProject,
  linkLineSchedule,
  loadBuilderState,
  moveProjectDate,
  neonBuilderStore,
  removeQuoteLine,
  retryQuoteLine,
  type BuilderContext,
} from "~/features/crm/bmi";
import { writeAudit } from "~/features/crm/core";
import { withCrmRoute } from "~/features/crm/core/http";
import type { CrmUser } from "~/features/crm/core/types";

/**
 * `/api/admin/crm/builder` — "Build in BMI" (C5).
 *
 * THE ONLY ROUTE IN THE CRM THAT WRITES TO BMI OFFICE. Everything it does goes
 * through `~/features/crm/bmi`'s builder service, which owns the write rail,
 * the kill switches, the project lock and the verify-after-every-200 rule. This
 * file is a shell: zod → `withCrmRoute` → service → audit.
 *
 * GET  `?lead=L-1042`  — the whole builder state in one read: the lead, the
 *      Office project, our quote lines with their write verdicts, the lines
 *      Office holds that we did not put there, the balance, whether writes are
 *      paused, and whether the centre's own server has caught up yet.
 *
 * POST — one discriminated `action` per mutation, and EVERY one answers with
 *      the same full state, re-read after the write. A mutation that returned
 *      only its own result would let the screen show a new line beside a stale
 *      total; a mutation that returned nothing would make the client guess.
 *
 * Errors a caller is MEANT to read come back as `CrmHttpError` codes with
 * Office's own prompt attached where there was one — `heat_full` in
 * particular, which is a soft refusal and not a failure.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function ctxFor(user: CrmUser): BuilderContext {
  return { store: neonBuilderStore, user };
}

export const GET = withCrmRoute(BuilderStateQuerySchema, async ({ input, user }) =>
  loadBuilderState(ctxFor(user), input.lead),
);

export const POST = withCrmRoute(BuilderPostSchema, async ({ input, user }) => {
  const ctx = ctxFor(user);

  switch (input.action) {
    case "create-project": {
      const state = await ensureOfficeProject(ctx, input.lead);
      await writeAudit({
        entity: "crm_lead",
        entityId: input.lead,
        action: "builder.create-project",
        actorEmail: user.email,
        after: { projectId: state.project?.projectId ?? null },
      });
      return state;
    }

    case "add-line": {
      const state = await addQuoteLine(ctx, {
        leadPublicId: input.lead,
        productId: input.productId,
        productName: input.productName,
        quantity: input.quantity,
        nameOverride: input.nameOverride ?? null,
      });
      await writeAudit({
        entity: "crm_lead",
        entityId: input.lead,
        action: "builder.add-line",
        actorEmail: user.email,
        after: { productId: input.productId, quantity: input.quantity },
      });
      return state;
    }

    case "apply-template": {
      const state = await applyTemplate(ctx, input.lead, input.templateId);
      await writeAudit({
        entity: "crm_lead",
        entityId: input.lead,
        action: "builder.apply-template",
        actorEmail: user.email,
        after: { templateId: input.templateId, lines: state.lines.length },
      });
      return state;
    }

    case "remove-line": {
      const state = await removeQuoteLine(ctx, input.lead, input.lineId);
      await writeAudit({
        entity: "crm_quote_line",
        entityId: input.lineId,
        action: "builder.remove-line",
        actorEmail: user.email,
      });
      return state;
    }

    case "retry-line":
      return retryQuoteLine(ctx, input.lead, input.lineId);

    case "link-schedule": {
      const state = await linkLineSchedule(ctx, {
        leadPublicId: input.lead,
        lineId: input.lineId,
        blocks: input.blocks,
        force: input.force,
      });
      await writeAudit({
        entity: "crm_quote_line",
        entityId: input.lineId,
        action: input.force ? "builder.link-schedule.forced" : "builder.link-schedule",
        actorEmail: user.email,
        after: { blocks: input.blocks },
      });
      return state;
    }

    case "move-date": {
      const state = await moveProjectDate(ctx, input.lead, input.date);
      await writeAudit({
        entity: "crm_lead",
        entityId: input.lead,
        action: "builder.move-date",
        actorEmail: user.email,
        after: { date: input.date },
      });
      return state;
    }

    // A plain re-read. It exists as an action so the screen's "check again"
    // button is a POST like every other control on it, rather than a GET the
    // browser might serve from a cache.
    case "sync":
      return loadBuilderState(ctx, input.lead);
  }
});
