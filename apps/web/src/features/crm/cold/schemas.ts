/**
 * Zod shapes for `/api/admin/crm/cold/**`.
 *
 * Clamped like every other admin input: the token guarding `/api/admin/*` is a
 * SHARED credential, so a body is hostile input rather than something only
 * staff can produce. The upload shapes are the strictest here — they carry
 * arbitrary text from somebody's spreadsheet, so every cell is length-capped
 * and every chunk is count-capped.
 */

import { z } from "zod";
import { CENTRE_CODES } from "../core/centres";
import { EVENT_TYPES } from "../core/types";
import {
  COLD_DECISIONS,
  COLD_DISPOSITIONS,
  COLD_MAX_BYTES,
  COLD_MAX_ROWS,
  COLD_ROWS_PER_CHUNK,
  COLD_ROW_FILTERS,
} from "./contracts";

export const ColdListIdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,18}$/, "expected a cold list id");

export const ColdRowIdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,18}$/, "expected a cold row id");

const RepId = z
  .string()
  .trim()
  .regex(/^\d{1,18}$/)
  .nullable();

const Bool = z.enum(["1", "0", "true", "false"]);

export function boolFlag(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return v === "1" || v === "true";
}

const Header = z.string().trim().min(1).max(200);

/** field → header, or null for "(skip)". Spelled out so an unknown field 400s. */
export const ColdColumnMapSchema = z.object({
  company: Header.nullable().optional(),
  contactName: Header.nullable().optional(),
  firstName: Header.nullable().optional(),
  lastName: Header.nullable().optional(),
  phone: Header.nullable().optional(),
  email: Header.nullable().optional(),
  city: Header.nullable().optional(),
  notes: Header.nullable().optional(),
  bmiPersonId: Header.nullable().optional(),
});

export const ColdParseMetaSchema = z.object({
  delimiter: z.string().min(1).max(4),
  hadBom: z.boolean(),
  hasHeaderRow: z.boolean(),
  blankRows: z.coerce.number().int().min(0).max(1_000_000),
  raggedRows: z.coerce.number().int().min(0).max(1_000_000),
  bytes: z.coerce.number().int().min(0).max(COLD_MAX_BYTES),
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** GET /cold */
export const ColdListsQuerySchema = z.object({
  includeArchived: Bool.optional(),
  owner: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
});

export type ColdListsQuery = z.infer<typeof ColdListsQuerySchema>;

/** POST /cold — create the list before the first record is posted. */
export const ColdCreateSchema = z.object({
  action: z.literal("create"),
  name: z.string().trim().min(1).max(160),
  ownerRepId: RepId.optional(),
  centre: z.enum(CENTRE_CODES).nullable().optional(),
  sourceFilename: z.string().trim().max(255).nullable().optional(),
  headers: z.array(Header).min(1).max(200),
  parseMeta: ColdParseMetaSchema.nullable().optional(),
  columnMap: ColdColumnMapSchema.nullable().optional(),
  token: z.string().max(300).optional(),
});

export type ColdCreateBody = z.infer<typeof ColdCreateSchema>;

/** GET /cold/[id] */
export const ColdListQuerySchema = z.object({
  filter: z.enum(COLD_ROW_FILTERS).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export type ColdListQueryInput = z.infer<typeof ColdListQuerySchema>;

/** POST /cold/[id] — map, commit, rename or archive. */
export const ColdListActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("map"),
    columnMap: ColdColumnMapSchema,
    token: z.string().max(300).optional(),
  }),
  z.object({
    action: z.literal("commit"),
    decisions: z
      .array(z.object({ rowId: ColdRowIdSchema, decision: z.enum(COLD_DECISIONS) }))
      .max(1000)
      .optional(),
    token: z.string().max(300).optional(),
  }),
  z.object({
    action: z.literal("update"),
    name: z.string().trim().min(1).max(160).optional(),
    ownerRepId: RepId.optional(),
    centre: z.enum(CENTRE_CODES).nullable().optional(),
    token: z.string().max(300).optional(),
  }),
  z.object({
    action: z.literal("archive"),
    archived: z.boolean(),
    token: z.string().max(300).optional(),
  }),
]);

export type ColdListActionBody = z.infer<typeof ColdListActionSchema>;

// ---------------------------------------------------------------------------
// The upload
// ---------------------------------------------------------------------------

/**
 * One chunk of raw records. `values` is whatever the file said, keyed by the
 * column names the parser found — no field names, no schema, because D9 is
 * open and the operator has not mapped anything yet.
 */
export const ColdRowsAppendSchema = z.object({
  records: z
    .array(
      z.object({
        index: z.coerce.number().int().min(1).max(COLD_MAX_ROWS),
        values: z.record(z.string().max(200), z.string().max(4000)),
      }),
    )
    .min(1)
    .max(COLD_ROWS_PER_CHUNK),
  token: z.string().max(300).optional(),
});

export type ColdRowsAppendBody = z.infer<typeof ColdRowsAppendSchema>;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const Hm = z
  .string()
  .regex(/^\d{2}:\d{2}(:\d{2})?$/, "expected HH:MM")
  .transform((v) => v.slice(0, 5));

export const ColdConvertDraftSchema = z.object({
  centre: z.enum(CENTRE_CODES),
  eventDate: Ymd,
  eventTime: Hm.nullable().optional(),
  guests: z.coerce.number().int().min(1).max(5000),
  type: z.enum(EVENT_TYPES),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).default(""),
  phone: z.string().trim().min(7).max(30).nullable().optional(),
  email: z.string().trim().toLowerCase().email().max(200).nullable().optional(),
  company: z.string().trim().max(160).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});

/** POST /cold/[id]/rows/[rowId] */
export const ColdRowActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("disposition"),
    disposition: z.enum(COLD_DISPOSITIONS),
    note: z.string().trim().max(2000).nullable().optional(),
    /** ISO instant; only "Callback scheduled" keeps it. */
    callbackAt: z.string().trim().max(40).nullable().optional(),
    token: z.string().max(300).optional(),
  }),
  z.object({
    action: z.literal("convert"),
    draft: ColdConvertDraftSchema,
    note: z.string().trim().max(2000).nullable().optional(),
    token: z.string().max(300).optional(),
  }),
  z.object({
    action: z.literal("decision"),
    decision: z.enum(COLD_DECISIONS),
    token: z.string().max(300).optional(),
  }),
]);

export type ColdRowActionBody = z.infer<typeof ColdRowActionSchema>;
