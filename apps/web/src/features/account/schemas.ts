import { z } from "zod";

/**
 * Zod schemas for the account API. `contact` is a single smart field — the
 * server re-derives email-vs-phone in `normalizeContact`, so we only bound the
 * length here. `code` must be exactly 6 digits.
 */
export const RequestOtpSchema = z.object({
  contact: z.string().trim().min(3).max(120),
});

export const VerifyOtpSchema = z.object({
  contact: z.string().trim().min(3).max(120),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code"),
});

export const AddCardSchema = z.object({
  cardToken: z.string().min(1).max(4096),
  verificationToken: z.string().max(8192).optional(),
  /** When present, the new card is attached to this subscription's customer. */
  forSubscriptionId: z.string().min(1).max(128).optional(),
});

export const SetCardSchema = z.object({
  cardId: z.string().min(1).max(128),
});

export type RequestOtpInput = z.infer<typeof RequestOtpSchema>;
export type VerifyOtpInput = z.infer<typeof VerifyOtpSchema>;
export type AddCardInput = z.infer<typeof AddCardSchema>;
export type SetCardInput = z.infer<typeof SetCardSchema>;
