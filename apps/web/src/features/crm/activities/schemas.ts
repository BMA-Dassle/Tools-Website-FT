/**
 * Zod shapes for `/api/admin/crm/leads/[id]/activities`.
 *
 * The POST is a discriminated union on `kind`, so a note can never arrive
 * carrying a call's duration and a snooze can never arrive without a preset —
 * the 400 says which field, and the service never sees a half-formed action.
 */

import { z } from "zod";
import { CALL_OUTCOMES, SNOOZE_PRESET_IDS } from "./contracts";

/** GET /leads/[id]/activities */
export const TimelineQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export type TimelineQuery = z.infer<typeof TimelineQuerySchema>;

export const NoteActionSchema = z.object({
  kind: z.literal("note"),
  body: z.string().trim().min(1, "a note needs some words").max(4000),
});

export const SnoozeActionSchema = z.object({
  kind: z.literal("snooze"),
  preset: z.enum(SNOOZE_PRESET_IDS),
});

export const CallActionSchema = z.object({
  kind: z.literal("call"),
  outcome: z.enum(CALL_OUTCOMES),
  note: z.string().trim().max(2000).optional().nullable(),
  /** Manual logging: a rep types minutes, not seconds; the sheet converts. */
  durationSeconds: z.coerce.number().int().min(0).max(86_400).optional().nullable(),
});

export const ActivityPostSchema = z.discriminatedUnion("kind", [
  NoteActionSchema,
  SnoozeActionSchema,
  CallActionSchema,
]);

export type ActivityPostBody = z.infer<typeof ActivityPostSchema>;
