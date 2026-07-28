/**
 * Kiosk code-entry classifier — pure, no DB / no network.
 *
 * One entry surface ("Coupon or voucher?") accepts typed codes AND raw scanner
 * payloads, so the first job is working out WHAT the guest presented. Ground
 * truth is the owner's live-scanner capture of 2026-07-27 (see
 * tasks/future/kiosk-coupons-vouchers.md § 1b):
 *
 *   BMI voucher      `C2D8M8D6M6C9M9U9U5K7Q6R9` — 24 chars, strictly
 *                    alternating letter/digit. Confirmed invariant across a
 *                    32-code BMI Office production batch: letters come from a
 *                    lookalike-free set (A B C D G H K M P Q R S T U X Z),
 *                    digits from 2–9 (never 0/1). We match the loose
 *                    `[A-Z][2-9]` pair — alternation + digits-2-9 already
 *                    excludes everything else this screen can see.
 *   Game Zone card   QR: `https://icardinc.net/<code>` (Intercard shortlink)
 *                    Barcode: bare account number zero-padded to 16 digits
 *                    (`0000000001063464`). MSR track-2 carries `;6283=<acct>?`.
 *   Square gift card QR: `sqgc://<16-digit GAN>`
 *                    Printed URL: `https://squareup.com/gift/balance/<token>`
 *   Coupon QR        Our printed/e-mailed coupons encode a booking URL with
 *                    `?code=X` (`https://headpinz.com/book/v2?code=SUMMER26`);
 *                    plain typed codes arrive as-is.
 *
 * Anything that isn't one of the above shapes is treated as a promo-code
 * candidate and left to the server validator to accept or reject — the
 * classifier never says "unrecognized" on its own for short alphanumerics.
 */

export type KioskCodeKind =
  | "bmi-voucher" // BMI voucher number → voucher flow
  | "promo" // discount/coupon code candidate → /api/booking/v2/promo
  | "game-card" // Intercard account / shortlink → Game Zone screens
  | "gift-card" // Square gift card → pay with it at the reader
  | "unknown"; // URL or payload we can't map to anything above

export interface ClassifiedCode {
  kind: KioskCodeKind;
  /** Normalized value: voucher/promo = uppercased code; game-card = account
   *  number (string — Intercard accounts stay strings end-to-end); gift-card =
   *  GAN when derivable, else the raw payload. */
  value: string;
  /** The raw input, trimmed — kept for logging/diagnostics. */
  raw: string;
}

/** BMI voucher number shape - single source in the shared booking layer. */
export { BMI_VOUCHER_RE } from "~/features/booking/service/voucher-redeem";
import { BMI_VOUCHER_RE } from "~/features/booking/service/voucher-redeem";

/** Intercard card-number QR shortlink host (see game-cards/resolve-scan). */
const ICARD_HOST_RE = /^https?:\/\/(?:www\.)?icardinc\.net\//i;
/** swflpassport / reload deep-links carry the account as ?id= */
const RELOAD_URL_RE = /^https?:\/\/(?:www\.)?(?:swflpassport\.com|headpinz\.com\/reload)/i;

/** Square gift card QR scheme + printed balance URL. */
const SQGC_RE = /^sqgc:\/\/(\d{6,})$/i;
const SQ_BALANCE_RE = /^https?:\/\/(?:www\.)?squareup\.com\/gift\/balance\//i;

/** Bare game-card barcode: all digits, long (the 1D barcode zero-pads to 16).
 *  8+ digits so short numeric promo codes (rare but legal) stay promos. */
const CARD_DIGITS_RE = /^\d{8,}$/;
/** MSR track-2 burst: `;6283=<account>?` (6283 = Intercard corp prefix). */
const TRACK2_RE = /^;?6283=(\d+)\??$/;

export function classifyKioskCode(input: string): ClassifiedCode {
  const raw = input.trim();
  const upper = raw.toUpperCase();

  // URL payloads first — they contain characters a code never has.
  if (/^(?:https?:\/\/|sqgc:\/\/)/i.test(raw)) {
    const sq = SQGC_RE.exec(raw);
    if (sq) return { kind: "gift-card", value: sq[1], raw };
    if (SQ_BALANCE_RE.test(raw)) return { kind: "gift-card", value: raw, raw };
    if (ICARD_HOST_RE.test(raw) || RELOAD_URL_RE.test(raw)) {
      const id = /[?&]id=(\d+)/.exec(raw)?.[1];
      return { kind: "game-card", value: id ?? raw, raw };
    }
    // Our own coupon QR: any URL carrying ?code= (printed flyers encode the
    // booking landing so phone cameras work too).
    const code = /[?&]code=([A-Za-z0-9-]+)/.exec(raw)?.[1];
    if (code) return classifyKioskCode(code);
    // A /v/{code} voucher deep-link (future print format) — take the last
    // path segment and re-classify it.
    const vPath = /\/v\/([A-Za-z0-9-]+)(?:[/?#]|$)/.exec(raw)?.[1];
    if (vPath) return classifyKioskCode(vPath);
    return { kind: "unknown", value: raw, raw };
  }

  const t2 = TRACK2_RE.exec(raw);
  if (t2) return { kind: "game-card", value: t2[1], raw };

  // Compact the typed/scanned code: codes never contain inner whitespace.
  const compact = upper.replace(/\s+/g, "");

  if (BMI_VOUCHER_RE.test(compact)) return { kind: "bmi-voucher", value: compact, raw };

  if (CARD_DIGITS_RE.test(compact)) {
    // Bare long digit run = the game-card barcode; strip the zero padding but
    // KEEP it a string (Intercard accounts exceed float-safe ranges upstream).
    return { kind: "game-card", value: compact.replace(/^0+(?=\d)/, ""), raw };
  }

  return { kind: "promo", value: compact, raw };
}
