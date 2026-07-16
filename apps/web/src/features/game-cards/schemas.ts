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

/** One line in the reload cart: a card + the package to load onto it. */
export const PurchaseItemSchema = z.object({
  accountNumber,
  packageId: z.string().min(1).max(64),
});
export type PurchaseItemInput = z.infer<typeof PurchaseItemSchema>;

export const PurchaseSchema = z
  .object({
    kind: z.literal("reload"),
    // One location per transaction (one Square order books to one location).
    locationCode: z.number().int(),
    // Cart of 1-10 cards, each with its own package (single card = cart of 1).
    items: z.array(PurchaseItemSchema).min(1).max(10),
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
