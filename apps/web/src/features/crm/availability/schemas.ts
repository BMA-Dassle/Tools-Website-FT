/**
 * Zod shapes for the availability routes. Both are GETs and every value comes
 * off the query string, which is the screen's source of truth (brief §3.1: a
 * link is a saved view), so each one is coerced and clamped here rather than
 * trusted anywhere downstream.
 */

import { z } from "zod";
import { CENTRE_CODES } from "~/features/crm/core/centres";

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const CentreCodeSchema = z.enum(CENTRE_CODES as readonly ["HPFM", "FT", "HPN"]);

/** The request bar's four durations (`crm-shared.js:513`). */
export const DURATIONS = [60, 90, 120, 180] as const;

const BoolParam = z
  .enum(["1", "true", "0", "false"])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === "1" || v === "true"));

/**
 * `GET /availability?centre&date&start&dur&guests[&lead][&refresh]`
 *
 * `start` is minutes from midnight so the URL survives a copy-paste without a
 * timezone argument; the screen renders it in ET and never parses it as a
 * `Date`. Everything is optional because `/availability/<leadId>` fills the
 * blanks from the lead, and the bare screen falls back to sensible defaults.
 */
export const AvailabilityQuerySchema = z.object({
  centre: CentreCodeSchema.optional(),
  date: Ymd.optional(),
  start: z.coerce
    .number()
    .int()
    .min(0)
    .max(24 * 60 - 1)
    .optional(),
  dur: z.coerce.number().int().min(30).max(600).optional(),
  guests: z.coerce.number().int().min(1).max(100_000).optional(),
  /** A `crm_leads.public_id`; when present it supplies the defaults. */
  lead: z
    .string()
    .trim()
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "expected a lead id")
    .optional(),
  /** Skip the 60-second cache — the screen's Refresh button. */
  refresh: BoolParam,
});

export type AvailabilityQuery = z.infer<typeof AvailabilityQuerySchema>;

/** `GET /heats?centre&date&guests[&resourceId][&refresh]` */
export const HeatsQuerySchema = z.object({
  centre: CentreCodeSchema.optional(),
  date: Ymd.optional(),
  guests: z.coerce.number().int().min(1).max(100_000).optional(),
  resourceId: z
    .string()
    .regex(/^\d{1,18}$/, "expected a numeric resource id")
    .optional(),
  lead: z
    .string()
    .trim()
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "expected a lead id")
    .optional(),
  refresh: BoolParam,
});

export type HeatsQuery = z.infer<typeof HeatsQuerySchema>;
