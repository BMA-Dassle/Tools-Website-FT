import { createHmac } from "crypto";
import { shortenUrl } from "@/lib/short-url";

/**
 * Canonical confirmation-link helpers.
 *
 * One booking → one signed confirmation URL → one short `/s/{code}`. Every
 * channel (customer email, SMS, the BMI reservation memo, and the admin
 * reservations board) resolves to the SAME `/s/{code}` so the destination,
 * Redis key, and click-tracking bucket are shared instead of each caller
 * minting its own random code.
 *
 * The short code is DETERMINISTIC (HMAC of the billId) so any caller — even a
 * client that can't read the secret — gets the identical link by asking the
 * server, and re-minting is idempotent (it just refreshes the short-url TTL).
 *
 * billId is a 17-digit BMI bigint: keep it a STRING everywhere here. Never
 * Number() / JSON-parse it — that rounds the id (the production off-by-one).
 */

// Same secret + fallback chain the notification route has always used, so
// previously-issued signed links keep validating after this extraction.
const HMAC_SECRET =
  process.env.BOOKING_HMAC_SECRET || process.env.SENDGRID_API_KEY || "fasttrax-booking-secret";

function siteBase(): string {
  return process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
}

/**
 * Signed confirmation URL so a billId can't be guessed/tampered. v1 bookings
 * point at /book/confirmation; v2 (multi-activity) bookings point at
 * /book/confirmation/v2 so the receipt link opens the page that actually
 * renders the booking.
 */
export function signedConfirmationUrl(billId: string, v2 = false): string {
  const sig = createHmac("sha256", HMAC_SECRET).update(billId).digest("hex").slice(0, 16);
  const path = v2 ? "/book/confirmation/v2" : "/book/confirmation";
  return `${siteBase()}${path}?billId=${encodeURIComponent(billId)}&sig=${sig}&referrer=receipt`;
}

/** Verify a signed billId (for a confirmation route to validate). */
export function verifyBillSignature(billId: string, sig: string): boolean {
  const expected = createHmac("sha256", HMAC_SECRET).update(billId).digest("hex").slice(0, 16);
  return sig === expected;
}

/**
 * Deterministic short code for a bill's confirmation link. Stable per billId
 * so email, SMS, memo, and admin all converge on one `/s/{code}`. Derived from
 * the same HMAC secret as the signature, so it's no more guessable than the
 * signed URL it points to.
 */
export function confirmationShortCode(billId: string): string {
  return createHmac("sha256", HMAC_SECRET)
    .update(`confirm:${billId}`)
    .digest("base64url")
    .slice(0, 8);
}

/**
 * Resolve (and idempotently store) the canonical short confirmation link for a
 * bill. Returns an absolute `${SITE_URL}/s/{code}` URL. Safe to call repeatedly
 * — it just refreshes the short-url mapping's TTL.
 */
export async function confirmationShortUrl(billId: string, v2 = false): Promise<string> {
  const code = confirmationShortCode(billId);
  // shortenUrl is idempotent when given an explicit code: it overwrites the
  // same `short:{code}` Redis key (refreshing TTL) and returns the code.
  await shortenUrl(signedConfirmationUrl(billId, v2), code);
  return `${siteBase()}/s/${code}`;
}
