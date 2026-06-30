/** Zod request schemas for the add-on API routes. */
import { z } from "zod";

export const addGuestSchema = z.object({
  firstName: z.string().trim().min(1, "First name required").max(60),
  lastName: z.string().trim().max(60).optional(),
  category: z.enum(["adult", "junior"]).optional(),
});

export const addOnQuoteRequestSchema = z.object({
  billId: z.string().regex(/^\d+$/, "billId must be the numeric BMI bill id"),
  guestCount: z.number().int().min(1).max(20),
});

export const addOnPurchaseRequestSchema = z.object({
  billId: z.string().regex(/^\d+$/, "billId must be the numeric BMI bill id"),
  guests: z.array(addGuestSchema).min(1).max(20),
  /** Square card payment token from the Web Payments SDK (single-use). */
  paymentToken: z.string().min(1),
  /** Client-supplied idempotency seed so reloads/retries never double-charge. */
  idempotencyKey: z.string().min(8).max(120),
  squareCustomerId: z.string().optional(),
});

export type AddOnQuoteRequest = z.infer<typeof addOnQuoteRequestSchema>;
export type AddOnPurchaseRequest = z.infer<typeof addOnPurchaseRequestSchema>;
