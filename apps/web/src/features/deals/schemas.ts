/**
 * Deal-pack request schemas.
 *
 * Note what the client is NOT allowed to send: a price, a tax amount, or the
 * voucher items. Those are all re-derived server-side from the slug (price↔charge
 * pairing is a hard repo rule). The one money number it does send is
 * `shownTotalCents` — not as an input to the charge, but so the server can
 * REFUSE if what the buyer saw no longer matches what the order prices at.
 */

import { z } from "zod";
import { DEAL_CATALOG, DEAL_LOCATIONS } from "./catalog";

const dealSlug = z.enum(
  DEAL_CATALOG.map((d) => d.slug) as [string, ...string[]],
);
const dealLocation = z.enum(DEAL_LOCATIONS as unknown as [string, ...string[]]);

/** Max packs any deal allows, so the schema rejects absurd quantities early. */
const MAX_QTY = Math.max(...DEAL_CATALOG.map((d) => d.maxPerBuyer));

export const DealQuoteSchema = z.object({
  slug: dealSlug,
  location: dealLocation,
  qty: z.number().int().min(1).max(MAX_QTY),
});
export type DealQuoteInput = z.infer<typeof DealQuoteSchema>;

/** Ad attribution captured off the landing URL. Values are clamped — these are
 *  attacker-controlled strings that end up in our own DB and admin UI. */
export const UtmSchema = z
  .object({
    utm_source: z.string().max(120).optional(),
    utm_medium: z.string().max(120).optional(),
    utm_campaign: z.string().max(200).optional(),
    utm_content: z.string().max(200).optional(),
    utm_term: z.string().max(200).optional(),
    gclid: z.string().max(200).optional(),
  })
  .partial()
  .optional();

export const DealPurchaseSchema = z.object({
  slug: dealSlug,
  location: dealLocation,
  qty: z.number().int().min(1).max(MAX_QTY),
  /** The total the buy panel displayed, in cents. Compared, never trusted. */
  shownTotalCents: z.number().int().positive(),
  buyer: z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email().max(200),
    /** Free-form; canonicalised to E.164 at persist time. */
    phone: z.string().trim().min(7).max(30),
    smsOptIn: z.boolean().default(false),
  }),
  /** Square card nonce, saved-card id, or wallet nonce. */
  cardNonce: z.string().min(1).max(4096),
  /** Terms-of-record version the buyer accepted. */
  clickwrapVersion: z.string().max(40).optional(),
  utm: UtmSchema,
});
export type DealPurchaseInput = z.infer<typeof DealPurchaseSchema>;
