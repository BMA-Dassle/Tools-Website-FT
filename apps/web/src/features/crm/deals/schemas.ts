/**
 * The wire shape for `GET /api/admin/crm/deals` — the ONE read behind
 * Pipeline, Contracts and Events (BUILD-BRIEF §B.15).
 *
 * The three screens differ only in `scope` and the window they ask for. They
 * used to be three separate queries and disagreed with each other: 177 open
 * contracts, 71 with a lead, 106 on one screen and invisible on the other.
 */

import { z } from "zod";
import { CENTRE_CODES } from "../core/centres";

const Ymd = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const DealsQuerySchema = z.object({
  /**
   * `board`   the mirror plus every live lead — Pipeline and My Day.
   * `quote`   only deals that HAVE a contract, keyed on the contract so two
   *           quotes for one project stay two rows — Contracts.
   * `project` the mirror alone, for a day or a date range — Events.
   */
  scope: z.enum(["board", "quote", "project"]).optional().default("board"),
  from: Ymd.optional(),
  until: Ymd.optional(),
  centre: z.enum(CENTRE_CODES).optional(),
  /** `crm_reps.slug`. Resolved to every id and name that can own a deal. */
  rep: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_-]{1,31}$/)
    .optional(),
  q: z.string().trim().max(80).optional(),
  /**
   * Cold-list prospects deliberately have no Office project and belong on Cold
   * lists rather than the board. Off by default so nothing is hidden unless a
   * screen asks.
   */
  excludeProspects: z.enum(["1", "0", "true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  /** Ask for the total as well as the page. */
  withTotal: z.enum(["1", "0", "true", "false"]).optional(),
});

export type DealsQuery = z.infer<typeof DealsQuerySchema>;
