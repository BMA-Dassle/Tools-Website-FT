/**
 * Zod shapes for the calls routes.
 *
 * Two audiences, two levels of paranoia:
 *   - `/api/admin/crm/calls/**` sits behind a SHARED admin credential, so a
 *     body is still hostile input and every field is clamped;
 *   - `/api/crm/3cx/**` is PUBLIC (secret-authenticated), so its shapes are
 *     tighter still: bounded strings, no free-form objects, and a number field
 *     that accepts what a PBX actually sends (`+1239…`, `239-555-…`, `9027`)
 *     without ever being coerced into a `Number`.
 */

import { z } from "zod";
import { CALL_DISPOSITIONS } from "./contracts";

/** A dialable string as a human or a PBX writes it. Never `z.coerce.number()`. */
const PhoneLike = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[+()\-.\s\d]+$/, "expected a phone number");

const CallId = z
  .string()
  .trim()
  .regex(/^\d{1,18}$/, "expected a call id");

const Bool = z.enum(["1", "0", "true", "false"]);

/** GET /calls */
export const CallsListQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  /** Director only; the service ignores it for a rep. */
  rep: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
  direction: z.enum(["in", "out"]).optional(),
  needsDisposition: Bool.optional(),
  missed: Bool.optional(),
});

export type CallsListQuery = z.infer<typeof CallsListQuerySchema>;

/** `"1"`/`"true"` → true; absent → undefined, which the filter treats as "no filter". */
export function boolFlag(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return v === "1" || v === "true";
}

/** POST /calls/dial */
export const CallDialSchema = z.object({
  number: PhoneLike,
  leadId: z
    .string()
    .trim()
    .regex(/^(L-)?\d{1,18}$/)
    .optional()
    .nullable(),
  token: z.string().max(300).optional(),
});

export type CallDialBody = z.infer<typeof CallDialSchema>;

/** POST /calls/[id]/disposition */
export const CallDispositionSchema = z.object({
  disposition: z.enum(CALL_DISPOSITIONS),
  note: z.string().trim().max(2000).optional().nullable(),
  token: z.string().max(300).optional(),
});

export type CallDispositionBody = z.infer<typeof CallDispositionSchema>;

/** POST /calls/[id]/link */
export const CallLinkSchema = z.object({
  leadId: z
    .string()
    .trim()
    .regex(/^(L-)?\d{1,18}$/),
  token: z.string().max(300).optional(),
});

export type CallLinkBody = z.infer<typeof CallLinkSchema>;

export const CallIdSchema = CallId;

// ---------------------------------------------------------------------------
// The public 3CX routes
// ---------------------------------------------------------------------------

/** GET /api/crm/3cx/lookup?number=…&k=… */
export const ThreecxLookupSchema = z.object({
  number: PhoneLike,
  /** Accepted here so the secret may ride the query string (`service/secret.ts`). */
  k: z.string().max(200).optional(),
});

/**
 * POST /api/crm/3cx/journal — the CRM-Integration template's end-of-call POST.
 *
 * `callId` is 3CX's `CallHistoryId` (a GUID) and is the dedupe key, so it is
 * REQUIRED; everything else is optional because template variables can be
 * blank and a half-filled journal entry is still worth more than none.
 */
export const ThreecxJournalSchema = z.object({
  callId: z.string().trim().min(1).max(120),
  direction: z.enum(["in", "out"]),
  number: PhoneLike,
  extension: z
    .string()
    .trim()
    .regex(/^\d{1,6}$/)
    .optional()
    .nullable(),
  name: z.string().trim().max(120).optional().nullable(),
  startedAt: z.string().trim().max(40).optional().nullable(),
  endedAt: z.string().trim().max(40).optional().nullable(),
  duration: z.coerce.number().int().min(0).max(86_400).optional().nullable(),
  status: z.string().trim().max(40).optional().nullable(),
  k: z.string().max(200).optional(),
});

export type ThreecxJournalBody = z.infer<typeof ThreecxJournalSchema>;
