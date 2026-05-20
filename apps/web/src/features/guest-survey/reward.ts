import { getPromoCodeByCode } from "@/lib/guest-survey-db";

/**
 * Guest-survey gift-card promo codes (`GS-XXXX`).
 *
 * The code is the human-readable handle we hand to the customer alongside
 * the Square Gift Card GAN. Cashiers can look up the survey/customer
 * lineage from the GS-XXXX code via guest_survey_promo_codes; the GAN
 * scans cleanly at POS for the actual redemption.
 *
 * Alphabet deliberately excludes O / 0 / I / 1 / L to avoid hand-keyed
 * read errors at the register.
 */

const PROMO_PREFIX = "GS-";
const PROMO_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/I/L
const PROMO_BODY_LENGTH = 4;
const DEFAULT_MAX_ATTEMPTS = 10;

/**
 * Generate a single random GS-XXXX code (no collision check).
 * Exported for tests; production callers use ensureUniquePromoCode.
 */
export function generatePromoCode(): string {
  let body = "";
  for (let i = 0; i < PROMO_BODY_LENGTH; i += 1) {
    body += PROMO_ALPHABET[Math.floor(Math.random() * PROMO_ALPHABET.length)];
  }
  return `${PROMO_PREFIX}${body}`;
}

/**
 * Generate a GS-XXXX code that doesn't already exist in
 * guest_survey_promo_codes. Tries up to `maxAttempts` times (4 chars in a
 * 30-char alphabet = 810,000 possible codes — collisions are extremely
 * unlikely until the table grows past several thousand outstanding codes).
 *
 * Throws if every attempt collides. Callers should treat this as a hard
 * failure of the reward issuance flow and roll back the gift card.
 */
export async function ensureUniquePromoCode(maxAttempts = DEFAULT_MAX_ATTEMPTS): Promise<string> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = generatePromoCode();
    const existing = await getPromoCodeByCode(candidate);
    if (!existing) return candidate;
    console.warn(
      `[guest-survey] promo code collision (${candidate}) on attempt ${attempt}/${maxAttempts}`,
    );
  }
  throw new Error(
    `Failed to generate a unique GS-XXXX code after ${maxAttempts} attempts — promo space exhausted or DB unreachable`,
  );
}

/** Cheap regex check used by the redemption webhook to recognize our codes. */
export function isGuestSurveyPromoCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return new RegExp(`^${PROMO_PREFIX}[${PROMO_ALPHABET}]{${PROMO_BODY_LENGTH}}$`).test(code);
}
