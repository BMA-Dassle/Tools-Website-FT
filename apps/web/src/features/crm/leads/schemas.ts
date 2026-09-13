/**
 * Zod shapes for `/api/admin/crm/leads/**`. Clamped like every other admin
 * input: the token that guards `/api/admin/*` is a shared credential, so a
 * body is hostile input, not something only staff can produce.
 */

import { z } from "zod";
import { CENTRE_CODES } from "../core/centres";
import { EVENT_TYPES, LEAD_SOURCES } from "../core/types";
import { STAFF_LEAD_SOURCES } from "./contracts";

export const LeadIdSchema = z
  .string()
  .trim()
  .regex(/^(L-)?\d{1,18}$/, "expected a lead id (L-123 or 123)");

export const RepIdOrNullSchema = z
  .string()
  .regex(/^\d{1,18}$/)
  .nullable();

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const Hm = z
  .string()
  .regex(/^\d{2}:\d{2}(:\d{2})?$/, "expected HH:MM")
  .transform((v) => v.slice(0, 5));

const Name = z.string().trim().min(1).max(80);
const Email = z.string().trim().toLowerCase().email().max(200);
const Phone = z.string().trim().min(7).max(30);

/** POST /leads — a member of staff logging a phone / walk-in / referral lead. */
export const LeadCreateSchema = z.object({
  centre: z.enum(CENTRE_CODES),
  source: z.enum(STAFF_LEAD_SOURCES),
  firstName: Name,
  lastName: Name,
  phone: Phone,
  email: Email.optional().nullable(),
  company: z.string().trim().max(120).optional().nullable(),
  eventDate: Ymd,
  eventTime: Hm.optional().nullable(),
  guests: z.coerce.number().int().min(1).max(5000),
  type: z.enum(EVENT_TYPES),
  kids: z.coerce.boolean().optional().default(false),
  notes: z.string().trim().max(4000).optional().nullable(),
  prefers: z.enum(["text", "call", "email"]).optional().nullable(),
});

export type LeadCreateBody = z.infer<typeof LeadCreateSchema>;

/** GET /leads */
export const LeadListQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  status: z.string().trim().max(32).optional(),
  rep: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
  /** "1" = only my leads (the signed-in rep's row). */
  mine: z.enum(["1", "0", "true", "false"]).optional(),
  centre: z.enum(CENTRE_CODES).optional(),
  q: z.string().trim().max(80).optional(),
  unassigned: z.enum(["1", "0", "true", "false"]).optional(),
  includeArchived: z.enum(["1", "0", "true", "false"]).optional(),
});

export type LeadListQuery = z.infer<typeof LeadListQuerySchema>;

/** PATCH /leads/[id] — the fields the deal lets a rep edit. */
export const LeadPatchSchema = z
  .object({
    eventDate: Ymd.optional(),
    eventTime: Hm.optional().nullable(),
    guests: z.coerce.number().int().min(1).max(5000).optional(),
    type: z.enum(EVENT_TYPES).optional(),
    kids: z.boolean().optional(),
    notes: z.string().trim().max(4000).optional().nullable(),
    valueCents: z.coerce.number().int().min(0).max(100_000_000).optional(),
    contact: z
      .object({
        firstName: Name.optional(),
        lastName: Name.optional(),
        phone: Phone.optional().nullable(),
        email: Email.optional().nullable(),
        prefers: z.enum(["text", "call", "email"]).optional().nullable(),
      })
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "nothing to change");

export type LeadPatchBody = z.infer<typeof LeadPatchSchema>;

/** POST /leads/[id]/assign */
export const LeadAssignSchema = z.object({
  /** null = release back to the queue. */
  repId: RepIdOrNullSchema,
  note: z.string().trim().max(500).optional().nullable(),
});

export type LeadAssignBody = z.infer<typeof LeadAssignSchema>;

export const EmptySchema = z.object({});

/** The web form's body (`components/SalesLeadForm.tsx`), unchanged on the wire. */
export const WebSubmitSchema = z.object({
  centerKey: z.string().trim().min(1).max(40),
  kind: z.enum(["group", "birthday"]).optional(),
  firstName: Name,
  lastName: Name,
  email: Email,
  phone: Phone,
  eventType: z.string().trim().max(40).optional(),
  preferredDate: Ymd.optional(),
  preferredTime: z
    .string()
    .trim()
    .regex(/^\d{2}:\d{2}(:\d{2})?$/)
    .optional(),
  guestCount: z.coerce.number().int().min(1).max(5000),
  notes: z.string().trim().max(4000).optional(),
  activityInterest: z.array(z.string().trim().max(60)).max(20).optional(),
  preferredContactMethod: z.enum(["phone", "text", "email"]).optional(),
  bestTimeToCall: z.enum(["Morning", "Afternoon", "Evening"]).optional(),
  packagePrefill: z.string().trim().max(120).optional(),
});

export type WebSubmitBody = z.infer<typeof WebSubmitSchema>;

export { LEAD_SOURCES, EVENT_TYPES };
