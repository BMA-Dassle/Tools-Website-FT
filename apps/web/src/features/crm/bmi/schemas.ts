/**
 * zod for the bmi sub's route inputs (History, Account, Last year) and the
 * backfill payload the director posts to `/jobs/run`.
 */

import { z } from "zod";
import { CENTRE_CODES, OFFICE_CLIENT_KEYS } from "../core/centres";

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

// ---------------------------------------------------------------------------
// C5 — the builder ("Build in BMI")
// ---------------------------------------------------------------------------

/**
 * A `crm_leads.public_id` ("L-1042"). Every builder call names one: there is no
 * "current lead" on the server, and a quote always belongs to a deal.
 */
const LeadId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "expected a lead id");

/** A Neon BIGSERIAL as text — never coerced to a number. */
const RowId = z.string().regex(/^\d{1,19}$/, "expected a row id");

/**
 * An Office id. Up to 18 digits and kept as a STRING all the way through: a
 * 17-digit id exceeds `Number.MAX_SAFE_INTEGER`, and `z.coerce.number()` here
 * would be the 2026 off-by-one under a new field name.
 */
const OfficeId = z.string().regex(/^\d{1,18}$/, "expected an Office id");

/**
 * Centre-local wall clock with NO offset: `2026-10-17T18:00:00`.
 *
 * Rejecting the `Z` and the `+04:00` forms is the point. Every time on this
 * wire is the centre's own clock, so nothing downstream can re-interpret an
 * evening in UTC and land it on the next day.
 */
const LocalStamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, "expected YYYY-MM-DDTHH:MM:SS with no offset");

export const ScheduleBlockSchema = z.object({
  resourceId: OfficeId,
  start: LocalStamp,
  stop: LocalStamp,
  persons: z.coerce.number().int().min(0).max(10_000),
});

/** `GET /builder?lead=` */
export const BuilderStateQuerySchema = z.object({ lead: LeadId });
export type BuilderStateQuery = z.infer<typeof BuilderStateQuerySchema>;

/**
 * `GET /builder/catalog?centre=&date=[&q=][&productId=][&quantity=]`
 *
 * With `productId` it is the picker's "price this one, for this date" read;
 * without, it is the names-only list. Either way `date` is required, because a
 * price with no date is a price for nothing.
 */
export const BuilderCatalogQuerySchema = z.object({
  centre: z.enum(CENTRE_CODES as readonly ["HPFM", "FT", "HPN"]),
  date: Ymd,
  q: z.string().trim().max(120).optional().default(""),
  productId: OfficeId.optional(),
  quantity: z.coerce.number().int().min(1).max(10_000).optional(),
  lead: LeadId.optional(),
});
export type BuilderCatalogQuery = z.infer<typeof BuilderCatalogQuerySchema>;

const ProductName = z.string().trim().min(1).max(200);
const Quantity = z.coerce.number().int().min(1).max(10_000);

/** `POST /builder` — one discriminated body per mutation the screen makes. */
export const BuilderPostSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create-project"), lead: LeadId }),
  z.object({
    action: z.literal("add-line"),
    lead: LeadId,
    productId: OfficeId,
    productName: ProductName,
    quantity: Quantity,
    nameOverride: z.string().trim().max(200).nullable().optional(),
  }),
  z.object({ action: z.literal("apply-template"), lead: LeadId, templateId: RowId }),
  z.object({ action: z.literal("remove-line"), lead: LeadId, lineId: RowId }),
  z.object({ action: z.literal("retry-line"), lead: LeadId, lineId: RowId }),
  z.object({
    action: z.literal("link-schedule"),
    lead: LeadId,
    lineId: RowId,
    blocks: z.array(ScheduleBlockSchema).min(1).max(24),
    /** Director only — re-sends the identical body with `confirm: true`. */
    force: z.boolean().optional(),
  }),
  z.object({ action: z.literal("move-date"), lead: LeadId, date: Ymd }),
  z.object({ action: z.literal("sync"), lead: LeadId }),
]);
export type BuilderPostInput = z.infer<typeof BuilderPostSchema>;

/** One template line: `{productId, per?, min?}` — never a price. */
export const TemplateLineSchema = z.object({
  productId: OfficeId,
  productName: ProductName.optional(),
  per: z.coerce.number().int().min(1).max(10_000).optional(),
  min: z.coerce.number().int().min(1).max(10_000).optional(),
});

/** `GET /builder/templates?centre=` */
export const BuilderTemplatesQuerySchema = z.object({
  centre: z.enum(CENTRE_CODES as readonly ["HPFM", "FT", "HPN"]).optional(),
});

/** `POST /builder/templates` */
export const BuilderTemplatesPostSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    name: z.string().trim().min(1).max(120),
    centre: z
      .enum(CENTRE_CODES as readonly ["HPFM", "FT", "HPN"])
      .nullable()
      .optional(),
    description: z.string().trim().max(500).nullable().optional(),
    baselineGuests: z.coerce.number().int().min(1).max(10_000),
    lines: z.array(TemplateLineSchema).min(1).max(60),
  }),
  z.object({ action: z.literal("archive"), id: RowId }),
]);
export type BuilderTemplatesPostInput = z.infer<typeof BuilderTemplatesPostSchema>;
