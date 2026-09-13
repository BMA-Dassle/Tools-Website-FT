/**
 * Zod shapes for the events sub's routes. Same rule as every other admin
 * input: `/api/admin/*` is guarded by a SHARED credential, so a body is
 * hostile input and every field is clamped.
 */

import { z } from "zod";
import { CENTRE_CODES } from "../core/centres";
import { EVENT_TYPES } from "../core/types";
import { EVENTS_VIEWS } from "./contracts";

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const Bool = z.enum(["1", "0", "true", "false"]).optional();

/** GET /events?centre=&view=&date=&cancelled= */
export const EventsBoardQuerySchema = z.object({
  centre: z.enum(CENTRE_CODES),
  view: z.enum(EVENTS_VIEWS).optional(),
  date: Ymd.optional(),
  cancelled: Bool,
});

export type EventsBoardQuery = z.infer<typeof EventsBoardQuerySchema>;

/** GET /events/[projectId]?centre= — an event with no lead row. */
export const EventDetailQuerySchema = z.object({
  centre: z.enum(CENTRE_CODES),
});

/**
 * BMI project ids are 17-digit strings; they arrive in the path, never parsed
 * as numbers (R1). Digits only, and never longer than Office's own ids.
 */
export const ProjectIdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,20}$/, "expected a BMI project id");

/**
 * POST /leads/[id]/notes/public. `preview: true` runs the clean-up and returns
 * both texts WITHOUT writing — the Preview button and the Save button send the
 * same body with that one flag flipped, so there is no second shape to keep in
 * step. `clean` runs the AI pass before the write (the Save default).
 */
export const PublicNotesPostSchema = z.object({
  notes: z.string().max(8000),
  preview: z.coerce.boolean().optional().default(false),
  clean: z.coerce.boolean().optional().default(true),
});

export type PublicNotesPostBody = z.infer<typeof PublicNotesPostSchema>;

/** POST /leads/[id]/notes/private */
export const PrivateNoteSchema = z.object({
  note: z.string().trim().min(1, "the note is empty").max(2000),
});

export type PrivateNoteBody = z.infer<typeof PrivateNoteSchema>;

/**
 * POST /leads/[id]/food-out — `"4:45 PM"`, `"16:30"`, or null to clear it.
 * Stored verbatim: the kitchen board and BMI both render the string.
 */
export const FoodOutSchema = z.object({
  foodOutTime: z
    .string()
    .trim()
    .max(20)
    .regex(/^\d{1,2}:\d{2}(\s?[AaPp][Mm])?$/, "expected a time like 4:45 PM or 16:30")
    .nullable(),
});

export type FoodOutBody = z.infer<typeof FoodOutSchema>;

/** POST /leads/[id]/waivers */
export const WaiversSchema = z.object({});

/**
 * POST /events/[projectId]/lead — a CRM row for a booking that already exists
 * in BMI. Every field is a staff entry, so every field is clamped; `type` and
 * `guests` come from the event but a human may correct them before saving.
 */
export const CreateLeadFromEventSchema = z.object({
  centre: z.enum(CENTRE_CODES),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).optional().default(""),
  phone: z.string().trim().min(7).max(30),
  email: z.string().trim().toLowerCase().email().max(200).nullable().optional(),
  company: z.string().trim().max(120).nullable().optional(),
  eventDate: Ymd,
  eventTime: z
    .string()
    .regex(/^\d{2}:\d{2}(:\d{2})?$/)
    .transform((v) => v.slice(0, 5))
    .nullable()
    .optional(),
  guests: z.coerce.number().int().min(1).max(5000),
  type: z.enum(EVENT_TYPES),
  notes: z.string().trim().max(4000).nullable().optional(),
});

export type CreateLeadFromEventBody = z.infer<typeof CreateLeadFromEventSchema>;
