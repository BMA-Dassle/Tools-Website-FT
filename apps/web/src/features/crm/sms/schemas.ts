/**
 * Zod shapes for `/api/admin/crm/sms/**` and `/api/admin/crm/templates`.
 *
 * Clamped like every other admin input: the token that guards `/api/admin/*`
 * is a shared credential, so a body is hostile input even though only staff can
 * reach the screen. The conversation key is validated by SHAPE here and parsed
 * again by `parseConversationKey` in the service — a key is a path segment, so
 * "looks like a key" and "is a key we minted" are two different questions.
 */

import { z } from "zod";
import { CONVERSATION_FOLDERS } from "./types";

/** `c-12` or `p-12395551234` — the same grammar `parseConversationKey` accepts. */
export const ConversationKeySchema = z
  .string()
  .trim()
  .regex(/^(c-\d{1,18}|p-\d{7,15})$/, "expected a conversation key (c-12 or p-12395551234)");

const Cursor = z.string().max(200).optional();

/** A text body: one or two segments' worth, never an essay pasted by accident. */
export const SmsBodySchema = z.string().trim().min(1).max(1000);

export const ThreadsListQuerySchema = z.object({
  cursor: Cursor,
  limit: z.coerce.number().int().min(1).max(200).optional(),
  folder: z.enum(CONVERSATION_FOLDERS).optional(),
  /** A director may ask for the whole team; a rep always sees their own. */
  all: z.enum(["0", "1"]).optional(),
});

export type ThreadsListQuery = z.infer<typeof ThreadsListQuerySchema>;

export const ThreadDetailQuerySchema = z.object({
  cursor: Cursor,
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const ThreadPostSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("send"),
    body: SmsBodySchema,
    templateId: z
      .string()
      .regex(/^\d{1,18}$/)
      .optional()
      .nullable(),
    leadId: z
      .string()
      .regex(/^\d{1,18}$/)
      .optional()
      .nullable(),
  }),
  z.object({ action: z.literal("read") }),
]);

export type ThreadPostBody = z.infer<typeof ThreadPostSchema>;

/** POST /sms/threads — start a conversation with a number that has no thread yet. */
export const NewTextSchema = z.object({
  to: z.string().trim().min(7).max(30),
  body: SmsBodySchema,
  leadId: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional()
    .nullable(),
  templateId: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional()
    .nullable(),
});

export const UnreadQuerySchema = z.object({
  all: z.enum(["0", "1"]).optional(),
});

/** GET /templates — rendered for a person when `key` is given. */
export const TemplatesQuerySchema = z.object({
  kind: z.enum(["sms", "email"]).optional(),
  key: ConversationKeySchema.optional(),
  centre: z.string().trim().max(8).optional(),
});

export const TemplateInputSchema = z.object({
  id: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional()
    .nullable(),
  kind: z.enum(["sms", "email"]),
  name: z.string().trim().min(1).max(80),
  subject: z.string().trim().max(200).optional().nullable(),
  body: z.string().trim().min(1).max(4000),
  centre: z.string().trim().max(8).optional().nullable(),
  position: z.coerce.number().int().min(0).max(9999).optional(),
});

export const TemplatesPostSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("upsert"), template: TemplateInputSchema }),
  z.object({
    action: z.literal("archive"),
    id: z.string().regex(/^\d{1,18}$/),
  }),
]);

export type TemplatesPostBody = z.infer<typeof TemplatesPostSchema>;
