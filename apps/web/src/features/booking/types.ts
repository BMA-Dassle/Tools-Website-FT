/**
 * Shared booking types — narrow, stable, imported everywhere in features/booking.
 *
 * Activity-specific draft shapes live in state/types.ts. This file holds the
 * cross-cutting primitives (activity enum, brand, status) so adapters and
 * components can refer to them without circular imports.
 */

/**
 * What a customer can BOOK in v2. NOT the same as Square's `Booking Activity`
 * custom attribute (which discriminates shuffly's FT-side vs HP-side under
 * the hood — the catalog resolves that via session.entryBrand).
 *
 * Race-packs are NOT a booking activity — they are credit-pack purchases
 * built later (PR-B4) as a SessionItem variant alongside BookingItem.
 */
export type Activity = "race" | "attraction" | "bowling" | "kbf";

export type Brand = "fasttrax" | "headpinz";

export type CenterCode = "fort-myers" | "naples";

/**
 * QAMF center id for a selected CenterCode. Bowling/KBF book against QAMF by
 * numeric center id; this is the ONLY mapping — callers must resolve from the
 * SELECTED center (session.center / the item's stamped center) and never
 * hard-default to one complex. Returns null when no center is selected, so the
 * caller fails loudly instead of silently booking the wrong center.
 */
export function qamfCenterIdForCode(center: CenterCode | null | undefined): number | null {
  return center === "naples" ? 3148 : center === "fort-myers" ? 9172 : null;
}

/** Square Order lifecycle state, mirrored from the Square API. */
export type SquareOrderStatus = "DRAFT" | "OPEN" | "COMPLETED" | "CANCELED";

/** Internal booking lifecycle tracked in Square Order metadata.ft_status. */
export type BookingStatus = "pending" | "vendor_booked" | "paid" | "failed" | "cancelled";

/**
 * Minimal contact info collected during checkout. Always required at payment
 * time; some activities populate it earlier (e.g. KBF identity step).
 *
 * Lives at `session.contact` — the BILLING customer (one per session). May or
 * may not also be a party member; the wizard's party step prompts them to add
 * themselves if they're participating. `smsOptIn` is a session-level choice
 * (controls the SMS confirmation send), not per-activity.
 */
export interface ContactInfo {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  smsOptIn: boolean;
}
