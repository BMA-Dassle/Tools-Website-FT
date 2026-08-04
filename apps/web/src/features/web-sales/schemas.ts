/**
 * Web-sales request schemas.
 *
 * Only the LIST query lives here today. The action schemas (resend, refund
 * dry-run, refund execute, void) arrive with the PRs that implement them —
 * shipping a validator for an endpoint that does not exist is dead code that
 * reads like a promise.
 *
 * Everything a caller can send is clamped. These values reach SQL parameters and
 * an admin UI, and the token that guards this route is a single shared secret
 * pasted into a URL — so treat the query string as hostile input, not as
 * something only staff can produce.
 */

import { z } from "zod";
import { SALE_SOURCE_IDS } from "./types";

const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** Widest window the board will scan. Guards against `from=1970-01-01`. */
export const MAX_RANGE_DAYS = 400;

export const SourceIdSchema = z.enum(SALE_SOURCE_IDS);

/**
 * Repeated query params arrive as `?source=deals&source=race-pack` OR as
 * `?source=deals,race-pack` depending on who built the URL. Accept both — the
 * board emits the comma form, humans and curl produce the repeated form.
 */
const csvList = (max: number) =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const parts = (Array.isArray(v) ? v : [v])
        .flatMap((s) => s.split(","))
        .map((s) => s.trim())
        .filter(Boolean);
      return parts.length > 0 ? Array.from(new Set(parts)).slice(0, max) : undefined;
    });

export const ListQuerySchema = z
  .object({
    from: YMD.optional(),
    to: YMD.optional(),
    source: csvList(SALE_SOURCE_IDS.length).pipe(z.array(SourceIdSchema).optional()),
    /** Source-native status values; each adapter validates its own. */
    status: csvList(24),
    venue: csvList(24),
    q: z.string().trim().min(1).max(120).optional(),
    /** Opaque base64url keyset cursor — see service/cursor.ts. */
    cursor: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    format: z.enum(["json", "csv"]).default("json"),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: "from must be on or before to",
    path: ["from"],
  });

export type ListQueryInput = z.infer<typeof ListQuerySchema>;

/**
 * Parse a `URLSearchParams` into the schema's shape, preserving repeated keys.
 *
 * `Object.fromEntries(searchParams)` silently keeps only the LAST value of a
 * repeated key, which would turn `?source=a&source=b` into just `b` — a filter
 * quietly narrowing itself is worse than one that errors.
 */
export function searchParamsToObject(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}
