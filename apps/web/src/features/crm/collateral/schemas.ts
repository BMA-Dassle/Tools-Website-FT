/**
 * Zod for every collateral, template and share route (brief §3.4: parse first,
 * authenticate second, act third).
 *
 * `token` is allowed on every POST body because `crmFetch` puts the minted
 * admin credential there as well as in the header; `withCrmRoute` reads it
 * before the schema sees it, but a schema that rejected the key would 400
 * every mutation.
 */

import { z } from "zod";
import type { CentreCode } from "../core/types";
import { COLLATERAL_TYPES } from "./contracts";
import { MAX_SHARE_DAYS } from "./service/share";

/**
 * Spelled out rather than built from `CENTRE_CODES`, so zod infers the literal
 * union and a `centre` reaches the data layer as a `CentreCode` rather than a
 * `string`. `satisfies` makes a drift from the registry a compile error, and
 * `core/centres.test.ts` already pins the registry itself.
 */
export const CentreCodeSchema = z.enum([
  "HPFM",
  "FT",
  "HPN",
] as const satisfies readonly CentreCode[]);

/** A Neon bigint as the client holds it. */
export const IdSchema = z.string().regex(/^\d{1,18}$/, "expected a numeric id");

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const TokenField = z.string().optional();

/**
 * A destination we are willing to 302 a guest to. HTTPS only, and no
 * credentials in the URL: a rep pasting a link is the one input here that is
 * not a file we stored ourselves.
 */
export const PublicUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((value) => {
    try {
      const u = new URL(value);
      return u.protocol === "https:" && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "expected an https:// URL");

export const TagsSchema = z.array(z.string().trim().min(1).max(30)).max(8);

export const CollateralListQuery = z.object({
  token: TokenField,
  centre: CentreCodeSchema.optional(),
  tag: z.string().trim().min(1).max(30).optional(),
  q: z.string().trim().max(80).optional(),
  archived: z.enum(["1", "0"]).optional(),
  expired: z.enum(["1", "0"]).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const CollateralCreateSchema = z.object({
  token: TokenField,
  title: z.string().trim().min(1).max(140),
  centre: CentreCodeSchema.nullish(),
  type: z.enum(COLLATERAL_TYPES).optional(),
  blobUrl: PublicUrlSchema,
  blobPathname: z.string().trim().max(400).nullish(),
  contentType: z.string().trim().max(120).nullish(),
  sizeBytes: z.number().int().min(0).max(1_000_000_000).nullish(),
  tags: TagsSchema.optional(),
  validFrom: Ymd.nullish(),
  validUntil: Ymd.nullish(),
});

export const CollateralPatchSchema = z.object({
  title: z.string().trim().min(1).max(140).optional(),
  centre: CentreCodeSchema.nullish(),
  type: z.enum(COLLATERAL_TYPES).optional(),
  blobUrl: PublicUrlSchema.optional(),
  tags: TagsSchema.optional(),
  validFrom: Ymd.nullish(),
  validUntil: Ymd.nullish(),
});

export const CollateralItemPostSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("update"), token: TokenField, patch: CollateralPatchSchema }),
  z.object({ action: z.literal("archive"), token: TokenField }),
  z.object({ action: z.literal("restore"), token: TokenField }),
]);

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const TemplateUpsertSchema = z.object({
  id: IdSchema.optional(),
  kind: z.enum(["sms", "email"]),
  name: z.string().trim().min(1).max(80),
  subject: z.string().trim().max(160).nullish(),
  body: z.string().min(1).max(4000),
  centre: CentreCodeSchema.nullish(),
  position: z.number().int().min(1).max(500).optional(),
});

export const TemplatesPostSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("upsert"), token: TokenField, template: TemplateUpsertSchema }),
  z.object({ action: z.literal("archive"), token: TokenField, id: IdSchema }),
  z.object({ action: z.literal("restore"), token: TokenField, id: IdSchema }),
  z.object({
    action: z.literal("reorder"),
    token: TokenField,
    ids: z.array(IdSchema).min(1).max(60),
  }),
]);

export const TemplatesListQuery = z.object({
  token: TokenField,
  kind: z.enum(["sms", "email"]).optional(),
  centre: CentreCodeSchema.optional(),
  archived: z.enum(["1", "0"]).optional(),
});

// ---------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------

export const ShareListQuery = z.object({
  token: TokenField,
  collateralId: IdSchema.optional(),
  lead: z.string().trim().max(40).optional(),
});

export const SharePostSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    token: TokenField,
    collateralId: IdSchema,
    lead: z.string().trim().max(40).nullish(),
    contactId: IdSchema.nullish(),
    channel: z.enum(["link", "sms", "email"]).optional(),
    expiresInDays: z.number().int().min(1).max(MAX_SHARE_DAYS).optional(),
  }),
  z.object({
    action: z.literal("revoke"),
    token: TokenField,
    shareToken: z.string().min(8).max(64),
  }),
]);
