/**
 * Shared booking types — narrow, stable, imported everywhere in features/booking.
 *
 * Activity-specific draft shapes live in state/types.ts. This file holds the
 * cross-cutting primitives (activity enum, brand, status) so adapters and
 * components can refer to them without circular imports.
 */

export type Activity = "race" | "race-pack" | "attraction" | "bowling" | "kbf";

export type Brand = "fasttrax" | "headpinz";

export type CenterCode = "fort-myers" | "naples";

/** Square Order lifecycle state, mirrored from the Square API. */
export type SquareOrderStatus = "DRAFT" | "OPEN" | "COMPLETED" | "CANCELED";

/** Internal booking lifecycle tracked in Square Order metadata.ft_status. */
export type BookingStatus = "pending" | "vendor_booked" | "paid" | "failed" | "cancelled";

/**
 * Minimal contact info collected during checkout. Always required at payment
 * time; some activities populate it earlier (e.g. KBF identity step).
 */
export interface ContactInfo {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

/** Activities valid for each brand's default landing. The chooser preselects. */
export const DEFAULT_ACTIVITY_BY_BRAND: Record<Brand, Activity> = {
  fasttrax: "race",
  headpinz: "bowling",
};
