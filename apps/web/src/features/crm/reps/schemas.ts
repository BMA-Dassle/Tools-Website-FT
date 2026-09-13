/**
 * Zod shapes for the roster. Clamped like every other admin input — the token
 * that guards `/api/admin/*` is a shared credential, so a query string is
 * hostile input, not something only staff can produce.
 */

import { z } from "zod";
import { REP_ROLES } from "~/features/crm/core/types";

export const RepSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{1,31}$/, "expected a lowercase slug");

export const RepRoleSchema = z.enum(REP_ROLES);

export const RepIdSchema = z.string().regex(/^\d{1,18}$/, "expected a numeric id");

export const RosterQuerySchema = z.object({
  includeInactive: z
    .enum(["1", "true", "0", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
  role: RepRoleSchema.optional(),
});

export type RosterQuery = z.infer<typeof RosterQuerySchema>;
