/**
 * zod for the bmi sub's route inputs (History, Account, Last year) and the
 * backfill payload the director posts to `/jobs/run`.
 */

import { z } from "zod";
import { OFFICE_CLIENT_KEYS } from "../core/centres";

const Limit = z.coerce.number().int().min(1).max(200).optional();
const Cursor = z.string().trim().min(1).max(200).optional();
const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const HistoryQuerySchema = z.object({
  q: z.string().trim().max(120).optional().default(""),
  limit: Limit,
  accountsCursor: Cursor,
  eventsCursor: Cursor,
});
export type HistoryQueryInput = z.infer<typeof HistoryQuerySchema>;

export const AccountQuerySchema = z.object({
  limit: Limit,
  cursor: Cursor,
});

export const LastYearQuerySchema = z.object({
  clientKey: z.enum(OFFICE_CLIENT_KEYS as unknown as [string, ...string[]]).optional(),
  limit: Limit,
  cursor: Cursor,
});

/** What the director posts as `payload` for `kind:"bmi-mirror-backfill"`. */
export const BackfillPayloadSchema = z
  .object({
    clientKey: z.enum(OFFICE_CLIENT_KEYS as unknown as [string, ...string[]]),
    from: Ymd,
    until: Ymd,
  })
  .refine((p) => p.from <= p.until, { message: "from must not be after until" });
export type BackfillPayloadInput = z.infer<typeof BackfillPayloadSchema>;
