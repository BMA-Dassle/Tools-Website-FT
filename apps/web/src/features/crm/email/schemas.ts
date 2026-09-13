/**
 * Zod for `/api/admin/crm/email**`. `withCrmRoute` parses BEFORE it checks the
 * credential, so every schema tolerates the `token` key the client adds to
 * each JSON body (zod strips unknown keys; it is named here for readers).
 */

import { z } from "zod";

/** `L-1042` or a bare numeric id — the same shape B3's `leadNumericId` takes. */
export const LeadRefSchema = z
  .string()
  .trim()
  .regex(/^(?:L-)?\d{1,18}$/, "expected a lead id like L-1042");

const EmailAddressSchema = z.string().trim().email().max(254);

export const EmailCursorSchema = z.string().trim().max(200).optional();

export const EmailLimitSchema = z.coerce.number().int().min(1).max(200).optional();

/** GET /email?leadId=…&limit=&cursor= */
export const EmailContextQuerySchema = z.object({
  leadId: LeadRefSchema,
  limit: EmailLimitSchema,
  cursor: EmailCursorSchema,
  token: z.string().optional(),
});

/** GET /email/threads?limit=&cursor= */
export const EmailThreadsQuerySchema = z.object({
  limit: EmailLimitSchema,
  cursor: EmailCursorSchema,
  token: z.string().optional(),
});

/**
 * POST /email. `to` and `cc` are optional: an empty `to` means "the lead's
 * guest email", which is what the composer sends. At most ten recipients —
 * this is a one-to-one sales rail, not a blast (R8's spirit for email).
 */
export const EmailSendSchema = z.object({
  leadId: LeadRefSchema,
  subject: z.string().trim().min(1, "a subject is required").max(255),
  body: z.string().min(1, "an empty email helps nobody").max(20_000),
  to: z.array(EmailAddressSchema).max(10).optional(),
  cc: z.array(EmailAddressSchema).max(10).optional(),
  templateId: z
    .string()
    .regex(/^\d{1,18}$/)
    .nullish(),
  token: z.string().optional(),
});

export type EmailContextQuery = z.output<typeof EmailContextQuerySchema>;
export type EmailThreadsQuery = z.output<typeof EmailThreadsQuerySchema>;
export type EmailSendInput = z.output<typeof EmailSendSchema>;
