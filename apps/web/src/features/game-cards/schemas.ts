/**
 * Zod request schemas for the game-cards API. Account numbers are kept as
 * STRINGS end-to-end (Intercard account numbers are bigint — never Number()).
 */

import { z } from "zod";

/** Card/account number: digits only, kept as a string (bigint-safe). */
const accountNumber = z
  .string()
  .trim()
  .regex(/^\d{1,19}$/, "Enter a valid card number");

const contact = z.object({
  firstName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  email: z.string().trim().email().max(160).optional(),
  phone: z.string().trim().max(40).optional(),
});

export const VerifyCardSchema = z.object({
  accountNumber,
  locationCode: z.number().int().optional(),
});
export type VerifyCardInput = z.infer<typeof VerifyCardSchema>;

export const PurchaseSchema = z
  .object({
    kind: z.literal("reload"),
    locationCode: z.number().int(),
    packageId: z.string().min(1).max(64),
    accountNumber,
    cardNonce: z.string().min(1).max(4096).optional(),
    giftCardNonce: z.string().min(1).max(4096).optional(),
    saveCard: z.boolean().optional(),
    squareCustomerId: z.string().max(128).optional(),
    contact: contact.optional(),
  })
  .refine((v) => !!v.cardNonce || !!v.giftCardNonce, {
    message: "A card or gift card is required",
    path: ["cardNonce"],
  });
export type PurchaseInput = z.infer<typeof PurchaseSchema>;
