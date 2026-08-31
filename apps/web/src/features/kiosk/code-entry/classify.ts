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
  | "native-voucher" // OUR voucher (HPW…) → internal redemption, no BMI call
  | "promo" // discount/coupon code candidate → /api/booking/v2/promo
  | "game-card" // Intercard account / shortlink → Game Zone screens
  | "gift-card" // Square gift card → pay with it at the reader
  | "groupon" // Groupon `VS-XXXX-…` long form → Groupon redemption
  | "unknown"; // URL or payload we can't map to anything above

export interface ClassifiedCode {
  kind: KioskCodeKind;
  /** Normalized value: voucher/promo = uppercased code; game-card = account
   *  number (string — Intercard accounts stay strings end-to-end); gift-card =
   *  GAN when derivable, else the raw payload. */
  value: string;
  /** The raw input, trimmed — kept for logging/diagnostics. */
  raw: string;
  /**
   * This code COULD be a Groupon redemption code, on shape alone.
   *
   * Shape cannot decide it. Groupon's short code is 7 OR 8 alphanumerics
   * (`GROUPON_CODE_RE`), which collides two ways: `89895632` (a real production
   * Groupon code) is all digits and so matches the bare game-card barcode rule,
   * and `WNDXH4DJ` is indistinguishable from a same-length promo code.
   *
   * So this is a HINT, never a verdict, and it deliberately does not change
   * `kind` for any input that already had one — an 8-digit run stays
   * `game-card`, a 7- or 8-character word stays `promo`. The call site tries
   * the primary path first and only falls back to Groupon when that refuses.
   * Both the ledger read and Groupon's GET are non-destructive, so a wrong
   * guess costs a round-trip and never a burned voucher.
   */
  grouponCandidate?: boolean;
}

/** BMI voucher number shape - single source in the shared booking layer. */
export { BMI_VOUCHER_RE } from "~/features/booking/service/voucher-redeem";
import { BMI_VOUCHER_RE } from "~/features/booking/service/voucher-redeem";
/** OUR voucher shape (`HPW` + 8) — the universal internal-issuer marker, so a
 *  scan is routed locally with no round-trip. Single source in game-cards. */
import { NATIVE_VOUCHER_RE, normalizeVoucherCode } from "~/features/game-cards/vouchers/codes";
/** Groupon code shapes. Pure module — deliberately NOT the `.server` resolver,
 *  which carries the signing key. */
import { GROUPON_CODE_RE, GROUPON_LONG_CODE_RE } from "~/features/groupon/codes";

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
/**
 * Width of the Intercard card barcode after its zero padding
 * (`0000000001037356` — the same 16 the mag track carries).
 *
 * It is the discriminator between the two padded digit runs a kiosk scanner
 * produces. Groupon's short code arrives padded SHORTER than this — 8 digits
 * inside a 12-wide symbol (`000089895632`, owner 2026-08-28) — so a run
 * narrower than the card barcode whose stripped form is Groupon-shaped is a
 * Groupon candidate, while a real 7-digit Intercard account sitting inside a
 * full-width 16 barcode is not. That asymmetry matters because Groupon is
 * asked FIRST for any candidate (routeWithGrouponFallback): flagging every
 * card scan would put a vendor round-trip in front of the most common scan on
 * the kiosk.
 */
const ICARD_BARCODE_DIGITS = 16;
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

  // OURS first — the printed/spoken form carries hyphens (HPW-4K7M-9PQR), so
  // normalize before matching. Checked ahead of the promo fallback so an
  // internal voucher is never mistaken for a discount code.
  const native = normalizeVoucherCode(raw);
  if (NATIVE_VOUCHER_RE.test(native)) return { kind: "native-voucher", value: native, raw };

  if (BMI_VOUCHER_RE.test(compact)) return { kind: "bmi-voucher", value: compact, raw };

  // Groupon's printed long form. The ONE Groupon shape nothing else can be:
  // without this it lands in the promo fallback, where it means nothing.
  if (GROUPON_LONG_CODE_RE.test(compact)) {
    return { kind: "groupon", value: compact, raw, grouponCandidate: true };
  }

  // The digits a lookup will actually be given: a 1D barcode zero-pads its
  // payload, and every downstream rail is handed the STRIPPED form.
  const stripped = compact.replace(/^0+(?=\d)/, "");

  // A HINT carried alongside whatever kind the code already had — never a kind
  // of its own, because a 7-/8-character code is genuinely ambiguous and this
  // function may not do I/O. See `grouponCandidate` on ClassifiedCode.
  //
  // TESTED ON THE STRIPPED VALUE TOO (owner 2026-08-28: a scanned Groupon was
  // dead at the kiosk while the same code typed by hand worked). The scanner
  // hands us `000089895632`; that is 12 characters, so the padded form misses
  // the 7-8 window, the hint was never set, and the run fell into the
  // game-card branch below — which never REFUSES, so the Groupon fallback had
  // nothing to fire on. Stripping first restores the same verdict the typed
  // `89895632` gets. Excluding the full-width card barcode keeps 7-digit
  // Intercard accounts (`0000000001037356`) off Groupon's lookup.
  const grouponCandidate =
    GROUPON_CODE_RE.test(compact) ||
    (compact.length < ICARD_BARCODE_DIGITS && GROUPON_CODE_RE.test(stripped));

  if (CARD_DIGITS_RE.test(compact)) {
    // Bare long digit run = the game-card barcode; strip the zero padding but
    // KEEP it a string (Intercard accounts exceed float-safe ranges upstream).
    // An 8-digit run reaches here too and STAYS a game-card: Groupon's
    // `89895632` is shaped identically to an unpadded Intercard account, so the
    // hint rides along and the call site resolves it by lookup. A 7-digit
    // Groupon never reaches this branch at all — `\d{8,}` does not match it, so
    // it falls to the promo catch-all below carrying the same hint.
    return {
      kind: "game-card",
      value: stripped,
      raw,
      ...(grouponCandidate && { grouponCandidate: true }),
    };
  }

  return {
    kind: "promo",
    value: compact,
    raw,
    ...(grouponCandidate && { grouponCandidate: true }),
  };
}
