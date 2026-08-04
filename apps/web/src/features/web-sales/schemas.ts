/**
 * Web-sales request schemas.
 *
 * The list query and the action bodies. Refund schemas arrive with the PR that
 * implements them — shipping a validator for an endpoint that does not exist is
 * dead code that reads like a promise.
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

/* ─────────────────────────────── actions ──────────────────────────────── */

/**
 * Every action body carries the token TWICE — once here and once on the query
 * string. The middleware admin gate runs before the route and cannot read a
 * request body, so it fails closed to a 404 on a POST whose token is body-only.
 * The deals board's Resend and Void both 404'd until the query param was added;
 * this route inherits the same shape rather than rediscovering it.
 */
const ActionBase = z.object({
  token: z.string().min(1),
  source: SourceIdSchema,
  /** Opaque, source-owned. Never parsed by the route. */
  ref: z.string().min(1).max(300),
});

export const ResendSchema = ActionBase.extend({
  action: z.literal("resend"),
  channel: z.enum(["sms", "email", "both"]),
  /** null = use the address on file. */
  overrideEmail: z.string().trim().toLowerCase().email().max(200).nullable().default(null),
  /**
   * E.164 only. `AdminResendModal` already normalises what staff type, so a
   * loosely-formatted number here means something bypassed the modal.
   */
  overridePhone: z
    .string()
    .regex(/^\+1\d{10}$/, "expected E.164, e.g. +12395551234")
    .nullable()
    .default(null),
});

export const PreviewSchema = ActionBase.extend({
  action: z.literal("preview_resend"),
  channel: z.enum(["sms", "email", "both"]),
});

export const VoidSchema = ActionBase.extend({
  action: z.literal("void"),
  /**
   * Enforced HERE, not only in the modal. The single-product board checked the
   * length in the browser, which anyone posting directly could skip — and a void
   * with no recorded reason is an unexplained destruction of value.
   */
  reason: z.string().trim().min(3).max(300),
});

export const RefundDryRunSchema = ActionBase.extend({
  action: z.literal("refund_dryrun"),
  destination: z.enum(["card", "gift_card"]),
  /** `null` on mount = plan the default selection (every untouched pack). */
  unitKeys: z.array(z.string().min(1).max(200)).max(100).nullable().default(null),
});

export const RefundExecuteSchema = ActionBase.extend({
  action: z.literal("refund_execute"),
  destination: z.enum(["card", "gift_card"]),
  unitKeys: z.array(z.string().min(1).max(200)).min(1).max(100),
  reason: z.string().trim().min(3).max(300),
  /** sha256 hex of the plan that was displayed. Mismatch = 409 plan_stale. */
  planHash: z.string().length(64),
});

/**
 * Dry-run and execute are SEPARATE members, not one action with a flag.
 *
 * Splitting them lets zod enforce that executing requires a reason, a
 * destination, a plan hash and a non-empty selection, while previewing requires
 * none of it. A shared shape would push all four checks into the handler, where
 * they are easier to forget on a money path.
 */
export const ActionSchema = z.discriminatedUnion("action", [
  ResendSchema,
  PreviewSchema,
  VoidSchema,
  RefundDryRunSchema,
  RefundExecuteSchema,
]);

export type ActionInput = z.infer<typeof ActionSchema>;

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
