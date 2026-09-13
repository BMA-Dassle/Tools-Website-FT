/**
 * zod for the bmi sub's route inputs (History, Account, Last year) and the
 * backfill payload the director posts to `/jobs/run`.
 */

import { z } from "zod";
import { OFFICE_CLIENT_KEYS } from "../core/centres";

const Limit = z.coerce.number().int().min(1).max(200).optional();
const Cursor = z.string().trim().min(1).max(200).optional();
const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * `?x=0` turns a part of the History response OFF; anything else (the absent
 * parameter included) leaves it on. The screen pages accounts and events with
 * their OWN cursors, and a list that has run out asks for it no more — without
 * that switch the server would answer a missing cursor with the list's FIRST
 * page again and the screen would show every row twice.
 */
const Flag = z
  .enum(["0", "1"])
  .optional()
  .transform((v) => v !== "0");

export const HistoryQuerySchema = z.object({
  q: z.string().trim().max(120).optional().default(""),
  limit: Limit,
  accountsCursor: Cursor,
  eventsCursor: Cursor,
  /** `accounts=0` / `events=0`: that list is finished, do not re-read it. */
  accounts: Flag,
  events: Flag,
  /** `status=0`: the mirror's counts are already on screen (they cost two counts). */
  status: Flag,
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
