/**
 * OUR OWN voucher code format — the universal internal-voucher shape.
 *
 * `HPW` + 8 characters, e.g. `HPW4K7M9PQR`, shown grouped as `HPW-4K7M-9PQR`.
 *
 * WHY A UNIVERSAL PREFIX (owner 2026-07-29: "our own universal prefix for our
 * own internal vouchers so you know when it comes across QR scan"): issuer
 * resolution has to be a LOCAL decision. The kiosk scan surface accepts paper
 * coupons, BMI vouchers, game cards, gift cards and now our vouchers, and it
 * must route a scan without a network round-trip to guess. `HPW` marks every
 * internally-issued voucher — not just Game Zone ones — so the classifier can
 * say "ours" on sight and later kinds inherit the same shape. What a code is
 * FOR lives in the database row (`vouchers.kind`), never in the code text; that
 * is the whole lesson of the BMI path, where value had to be inferred from
 * free-form setup prose.
 *
 * Cannot collide with BMI's shape (`^([A-Z][2-9]){12}$`, 24 chars) — different
 * length, and `HPW` is three letters in a row, which strict alternation forbids.
 *
 * ALPHABET: Crockford base32 minus the ambiguous pair 0/O and 1/I/L, so a code
 * read aloud or hand-copied off a printed voucher can't drift. 30 symbols ^ 8 =
 * ~6.6e11 codes; brute-forcing is further bounded by rate limiting on the
 * redeem route (these are individually issued, never bulk-listed).
 */

/** No 0/1/I/L/O/U — nothing in here is confusable with another member. */
export const VOUCHER_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Marks a voucher as OURS (any internal kind), vs a BMI-issued one. */
export const NATIVE_VOUCHER_PREFIX = "HPW";

const BODY_LENGTH = 8;

/** Canonical stored/compared form: `HPW` + 8 alphabet chars, no separators. */
export const NATIVE_VOUCHER_RE = new RegExp(
  `^${NATIVE_VOUCHER_PREFIX}[${VOUCHER_ALPHABET}]{${BODY_LENGTH}}$`,
);

/**
 * Scanner/keyboard input → canonical form. Strips the hyphens and spaces the
 * printed/spoken form carries, uppercases, and drops nothing else — an
 * unexpected character must FAIL validation, not get silently removed into a
 * different valid code.
 */
export function normalizeVoucherCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]+/g, "");
}

export function isNativeVoucherCode(input: string): boolean {
  return NATIVE_VOUCHER_RE.test(normalizeVoucherCode(input));
}

/** Guest-facing grouping: `HPW-4K7M-9PQR`. Display only — never stored. */
export function formatVoucherCode(code: string): string {
  const c = normalizeVoucherCode(code);
  if (!NATIVE_VOUCHER_RE.test(c)) return c;
  const body = c.slice(NATIVE_VOUCHER_PREFIX.length);
  return `${NATIVE_VOUCHER_PREFIX}-${body.slice(0, 4)}-${body.slice(4)}`;
}

/**
 * Generate a code. Uses `crypto.randomInt` (CSPRNG, rejection-sampled) rather
 * than Math.random: these are bearer instruments worth real money, and a
 * predictable sequence would let someone walk the space. Uniform over the
 * alphabet — no modulo bias.
 */
export function generateVoucherCode(randomInt: (max: number) => number): string {
  let body = "";
  for (let i = 0; i < BODY_LENGTH; i++) {
    body += VOUCHER_ALPHABET[randomInt(VOUCHER_ALPHABET.length)];
  }
  return `${NATIVE_VOUCHER_PREFIX}${body}`;
}
