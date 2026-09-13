/**
 * Zod shapes for the rules routes. Clamped like every other admin input — the
 * token that guards `/api/admin/*` is a shared credential, so a body is
 * hostile input, not something only a director can produce.
 *
 * Rep references inside a rule (`then.hold` / `then.route`) are SLUGS, as the
 * prototype wrote them and the seed stores them.
 */

import { z } from "zod";
import { CENTRE_CODES } from "~/features/crm/core/centres";
import { EVENT_TYPES, LEAD_SOURCES } from "~/features/crm/core/types";

export const RULE_KINDS = ["hold", "route", "avail", "standard", "fallback"] as const;

const RepSlug = z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/, "expected a rep slug");
const NumericId = z.string().regex(/^\d{1,18}$/, "expected a numeric id");
const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const CentreCodeSchema = z.enum(CENTRE_CODES as readonly ["HPFM", "FT", "HPN"]);

export const RuleWhenSchema = z
  .object({
    guestsMin: z.number().int().min(0).max(100_000).optional(),
    guestsMax: z.number().int().min(0).max(100_000).optional(),
    type: z.enum(EVENT_TYPES).optional(),
    kids: z.boolean().optional(),
    centre: CentreCodeSchema.optional(),
    source: z.enum(LEAD_SOURCES).optional(),
    partyMonth: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM")
      .optional(),
  })
  .strict()
  .refine(
    (w) => w.guestsMin === undefined || w.guestsMax === undefined || w.guestsMin <= w.guestsMax,
    "guestsMin must not exceed guestsMax",
  );

export const RuleThenSchema = z
  .object({
    hold: RepSlug.optional(),
    route: RepSlug.optional(),
    skipOff: z.boolean().optional(),
    onShift: z.boolean().optional(),
    standard: z.boolean().optional(),
    queue: z.boolean().optional(),
  })
  .strict();

/** A rule as the sheet posts it; `id` absent = create. Kind and `then` must agree. */
export const RuleInputSchema = z
  .object({
    id: NumericId.optional(),
    label: z.string().trim().min(1).max(120),
    kind: z.enum(RULE_KINDS),
    why: z.string().trim().max(240).nullable().optional(),
    when: RuleWhenSchema.default({}),
    then: RuleThenSchema.default({}),
    enabled: z.boolean().optional(),
  })
  .superRefine((r, ctx) => {
    const t = r.then;
    const need = (ok: boolean, message: string) => {
      if (!ok) ctx.addIssue({ code: "custom", path: ["then"], message });
    };
    switch (r.kind) {
      case "hold":
        need(!!t.hold, "a hold rule names the person to hold for");
        break;
      case "route":
        need(!!t.route, "a route rule names the person or team");
        break;
      case "avail":
        need(
          t.skipOff === true || t.onShift === true,
          "an availability rule is skipOff or onShift",
        );
        break;
      case "standard":
        need(t.standard === true, "a standard rule sets standard:true");
        break;
      case "fallback":
        need(t.queue === true, "a fallback rule sets queue:true");
        break;
    }
  });

export type RuleInputParsed = z.infer<typeof RuleInputSchema>;

export const RulesPostBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("upsert"), rule: RuleInputSchema }),
  z.object({ action: z.literal("toggle"), id: NumericId, enabled: z.boolean() }),
  z.object({ action: z.literal("reorder"), ids: z.array(NumericId).min(1).max(100) }),
]);

export type RulesPostBodyParsed = z.infer<typeof RulesPostBodySchema>;

const BoolParam = z
  .enum(["1", "true", "0", "false"])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === "1" || v === "true"));

/** `GET /rules/try?guests=&type=&centre=&eventDate=&kids=&source=` — a hypothetical lead. */
export const TryLeadQuerySchema = z.object({
  guests: z.coerce.number().int().min(1).max(100_000),
  type: z.enum(EVENT_TYPES),
  centre: CentreCodeSchema,
  eventDate: Ymd.optional(),
  kids: BoolParam,
  source: z.enum(LEAD_SOURCES).optional(),
});

export type TryLeadQuery = z.infer<typeof TryLeadQuerySchema>;

/** `POST /roster` — the off-today override. */
export const RosterPostBodySchema = z.object({
  repId: NumericId,
  date: Ymd.optional(),
  off: z.boolean(),
  reason: z.string().trim().max(80).optional(),
});

export type RosterPostBodyParsed = z.infer<typeof RosterPostBodySchema>;

/** `GET /roster?date=` — defaults to ET today. */
export const RosterQuerySchema = z.object({ date: Ymd.optional() });

/**
 * `POST /rules/gs` — the Guest Services department config and the per-person
 * "works leads as Guest Services" toggle (§5.7b). `departments` takes a LIST so
 * a second call centre needs no migration; the toggle takes ONE address at a
 * time, because a bulk import of the department's emails is exactly the thing
 * that would sign the directors in as the bucket.
 */
export const GsPostBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("departments"),
    ids: z.array(z.number().int().min(1).max(2_147_483_647)).max(10),
    name: z.string().trim().min(1).max(60).optional(),
  }),
  z.object({
    action: z.literal("login"),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(160)
      .regex(/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i, "expected an email address"),
    works: z.boolean(),
  }),
]);

export type GsPostBodyParsed = z.infer<typeof GsPostBodySchema>;
