/**
 * Zod for the four measure routes. `withCrmRoute` parses the query string on a
 * GET and the JSON body on a POST, so every schema also tolerates the optional
 * `token` a POST body may carry (brief §3.4).
 */

import { z } from "zod";
import { ACCOUNTABILITY_RANGES } from "./contracts";

const Token = z.string().min(1).optional();

/** A rep SLUG, never an id: slugs are stable and safe in a URL. */
const RepSlug = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]{1,32}$/, "rep must be a slug")
  .optional();

export const KpiQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  quarter: z
    .string()
    .regex(/^\d{4}-Q[1-4]$/)
    .optional(),
  rep: RepSlug,
  centre: z.enum(["HPFM", "FT", "HPN"]).optional(),
  token: Token,
});

export type KpiQueryInput = z.infer<typeof KpiQuerySchema>;

export const AccountabilityQuerySchema = z.object({
  range: z.enum(ACCOUNTABILITY_RANGES as unknown as [string, ...string[]]).optional(),
  rep: RepSlug,
  /** `1` asks for the signed-in person's own week only (the My Day strip). */
  mine: z.enum(["0", "1"]).optional(),
  token: Token,
});

export type AccountabilityQueryInput = z.infer<typeof AccountabilityQuerySchema>;

export const TargetsQuerySchema = z.object({ token: Token });

export const TargetsPostSchema = z.object({
  repSlug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,32}$/),
  calls: z.number().int().min(0).max(2000),
  texts: z.number().int().min(0).max(2000),
  emails: z.number().int().min(0).max(2000),
  reachouts: z.number().int().min(0).max(2000),
  responseTargetMinutes: z.number().int().min(1).max(1440),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  token: Token,
});

export const GoalsQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  token: Token,
});

/**
 * A goal is a WHOLE NUMBER OF CENTS and cannot be negative. The grid posts
 * every cell it holds, so the cap is per cell, not per save: a goal above
 * $10,000,000 for one salesperson in one month is a typo, and a typo that
 * reaches Pandora becomes somebody's commission target.
 */
export const GoalsPostSchema = z.object({
  goals: z
    .array(
      z.object({
        repSlug: z
          .string()
          .trim()
          .regex(/^[a-z0-9-]{1,32}$/),
        year: z.number().int().min(2000).max(2100),
        month: z.number().int().min(1).max(12),
        goalCents: z.number().int().min(0).max(1_000_000_000),
      }),
    )
    .min(1)
    .max(240),
  token: Token,
});
