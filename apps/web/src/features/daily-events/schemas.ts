import { z } from "zod";

/**
 * Zod schemas for the daily-events admin API routes.
 *
 * locationId keeps the portal's numeric 7shifts ids (332160 / 467486 / 332145)
 * so the moved UI and the portal iframe contract stay identical.
 * projectId is a digit string — NEVER coerced through Number() (17-digit BMI id).
 */

export const locationIdSchema = z
  .string()
  .regex(/^\d+$/, "locationId must be numeric")
  .transform(Number)
  .refine((n) => [332160, 467486, 332145].includes(n), {
    message: "SMS-Timing is not configured for this location",
  });

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

export const projectIdSchema = z.string().regex(/^-?\d{1,20}$/, "projectId must be a digit string");

export const listQuerySchema = z.object({
  locationId: locationIdSchema,
  date: dateSchema,
  includeAll: z.enum(["true", "false"]).optional(),
});

export const detailQuerySchema = z.object({
  locationId: locationIdSchema,
});

export const metadataGetQuerySchema = z.object({
  locationId: locationIdSchema,
  projectId: projectIdSchema,
  date: dateSchema,
});

/** POST body — portal contract: extraction inputs come from the loaded detail. */
export const metadataExtractBodySchema = z.object({
  eventName: z.string().optional().default(""),
  startTime: z.string().optional().default(""),
  persons: z.coerce.number().optional().default(0),
  notes: z.string().optional().default(""),
});

/** PUT body — manual food-out override (null/empty clears the time). */
export const metadataManualBodySchema = z.object({
  locationId: z.coerce
    .number()
    .refine((n) => [332160, 467486, 332145].includes(n), { message: "Unknown location" }),
  projectId: projectIdSchema,
  date: dateSchema,
  foodOutTime: z.string().nullable().optional(),
});
