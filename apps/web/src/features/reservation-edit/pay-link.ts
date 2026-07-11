/**
 * Self-hosted payment-difference links (owner decision #3).
 *
 * When an edit increases the price and no card is on file (or it declined),
 * staff send the guest a link to OUR page (app/pay/edit/[editId]) — never a
 * Square-generated link. The link carries an HMAC token so the editId alone
 * can't be replayed by a third party, and it expires at 24h after creation
 * or 1h before the event, whichever comes first.
 */

import { createHmac, timingSafeEqual } from "crypto";

const secret = (): string =>
  process.env.EDIT_PAY_LINK_SECRET || process.env.ADMIN_CAMERA_TOKEN || "";

/** HMAC token for an edit's payment link. */
export const payLinkToken = (editId: string): string =>
  createHmac("sha256", secret()).update(`edit-pay:${editId}`).digest("hex").slice(0, 32);

export const verifyPayLinkToken = (editId: string, token: string): boolean => {
  if (!secret() || !token) return false;
  const expected = payLinkToken(editId);
  if (token.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
};

/** Absolute link for the guest (origin = the serving host). */
export const buildPayLinkUrl = (origin: string, editId: string): string =>
  `${origin}/pay/edit/${encodeURIComponent(editId)}?t=${payLinkToken(editId)}`;

/**
 * Expiry: link creation + 24h, or 1h before the event, whichever is first.
 * `eventAtMs` may be missing (bad rows) — then the 24h rule alone applies.
 */
export const payLinkExpiresAtMs = (createdAtMs: number, eventAtMs: number | null): number => {
  const byCreation = createdAtMs + 24 * 60 * 60_000;
  if (eventAtMs == null) return byCreation;
  return Math.min(byCreation, eventAtMs - 60 * 60_000);
};

export const payLinkExpired = (
  createdAtMs: number,
  eventAtMs: number | null,
  nowMs: number,
): boolean => nowMs >= payLinkExpiresAtMs(createdAtMs, eventAtMs);
