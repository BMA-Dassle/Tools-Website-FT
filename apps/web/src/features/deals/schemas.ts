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
  /**
   * TRUE (default) = all packs on ONE voucher code. FALSE = one code per pack.
   * Defaults to combining because that is what a single buyer wants, and it costs
   * them nothing: legs are claimed independently, so one code still shares.
   * Separate codes only help when the packs go to different people.
   */
  combine: z.boolean().default(true),
  /** The total the buy panel displayed, in cents. Compared, never trusted. */
  shownTotalCents: z.number().int().positive(),
  buyer: z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email().max(200),
    /** Free-form; canonicalised to E.164 at persist time. */
    phone: z.string().trim().min(7).max(30),
    smsOptIn: z.boolean().default(false),
  }),
  /**
   * Present when the buyer is sending this to someone else.
   *
   * The recipient's PHONE IS OPTIONAL and their email is not. A gift text goes to
   * somebody who never gave us their number — one transactional "you've been sent
   * a gift" message is defensible, a required field that quietly builds a list of
   * non-consenting numbers is not. Email is the delivery of record; SMS is a
   * nudge the buyer opts into on the recipient's behalf.
   *
   * `sendDate` is a calendar date (YYYY-MM-DD) in Eastern, not an instant — the
   * buyer picks a DAY. Resolving it to a send time is `checkGiftDate`'s job, and
   * it is re-validated server-side because the picker's min/max are only a hint.
   */
  gift: z
    .object({
      recipientName: z.string().trim().min(1).max(120),
      recipientEmail: z.string().trim().toLowerCase().email().max(200),
      recipientPhone: z.string().trim().max(30).optional(),
      message: z.string().trim().max(300).optional(),
      sendDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Delivery date must be YYYY-MM-DD")
        .optional(),
    })
    .optional(),
  /** Square card nonce, saved-card id, or wallet nonce. */
  cardNonce: z.string().min(1).max(4096),
  /** Terms-of-record version the buyer accepted. */
  clickwrapVersion: z.string().max(40).optional(),
  utm: UtmSchema,
});
export type DealPurchaseInput = z.infer<typeof DealPurchaseSchema>;
