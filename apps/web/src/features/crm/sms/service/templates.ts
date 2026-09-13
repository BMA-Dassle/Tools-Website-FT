/**
 * The template picker's data: stored templates, merged for one person.
 *
 * R11 — no hard-coded guest strings. Every body a guest receives comes from
 * `crm_templates` (seeded T-1..T-6 from the prototype) and is merged
 * server-side; the composer only ever shows what came back from here, so a
 * template edit on the Collateral screen changes what reps send without a
 * deploy.
 *
 * GSM-7 is applied to SMS templates at render time, so the picker shows the
 * text that will actually go out — em dash and all, normalised — rather than
 * a draft that the service would rewrite behind the rep's back.
 */

import { listTemplates } from "../data/templates-db";
import type { RenderedTemplate } from "../types";
import { renderTemplate, type MergeContext } from "./templates-merge";

export interface LoadTemplatesInput extends MergeContext {
  kind?: "sms" | "email";
  centre?: string | null;
}

export async function loadRenderedTemplates(
  input: LoadTemplatesInput,
): Promise<RenderedTemplate[]> {
  const templates = await listTemplates({
    kind: input.kind,
    centre: input.centre ?? input.lead?.centre ?? null,
  });
  const ctx: MergeContext = { contact: input.contact, lead: input.lead, rep: input.rep };
  return templates.map((t) => renderTemplate(t, ctx));
}
