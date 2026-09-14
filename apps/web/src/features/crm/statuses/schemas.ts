/**
 * Zod shapes for the pipeline board and a status change.
 *
 * Clamped like every other admin input: the credential that guards
 * `/api/admin/*` is shared, so a body is hostile input, not something only
 * staff can produce.
 */

import { z } from "zod";
import { CENTRE_CODES } from "../core/centres";

/**
 * The same shape `data/statuses-db.ts` exports as `STATUS_ID_RE`, spelled out
 * here rather than imported: this module is type-imported by client code, and
 * a value import from a `data/*` file would put `@ft/db` one careless edit
 * away from the browser bundle (§5.7b). `statuses-db.test` pins the shape.
 */
const StatusId = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{1,31}$/, "expected a status id");

/** GET /pipeline */
export const PipelineQuerySchema = z.object({
  /** "rep" = swimlanes (director view). Anything else = plain columns. */
  by: z.enum(["rep", "status"]).optional(),
  centre: z.enum(CENTRE_CODES).optional(),
  q: z.string().trim().max(80).optional(),
  /** "1" = only the signed-in rep's leads; the board defaults to that for reps. */
  mine: z.enum(["1", "0", "true", "false"]).optional(),
  /**
   * A director narrowing the board to ONE salesperson (`crm_reps.slug`).
   * Owner, 2026-09-13: "need person filter too". Ignored for a rep, whose board
   * is already their own — the route never lets one widen its own scope.
   */
  rep: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_-]{1,31}$/)
    .optional(),
});

export type PipelineQuery = z.infer<typeof PipelineQuerySchema>;

/** POST /leads/[id]/status */
export const LeadStatusSchema = z.object({
  statusId: StatusId,
  /** Recorded on the lead when the new status is a lost one. */
  lostReason: z.string().trim().max(200).optional().nullable(),
  /** Appended to the timeline line, never written to BMI. */
  note: z.string().trim().max(500).optional().nullable(),
});

export type LeadStatusBody = z.infer<typeof LeadStatusSchema>;
