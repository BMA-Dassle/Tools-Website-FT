/**
 * Entry-screen scan router — pure, no DB / no network.
 *
 * The attract screen and the category chooser/shelves are the first things a
 * guest sees, and the QR reader is always listening there. Unlike every other
 * scan surface, these screens have NO context: the guest could be holding a
 * reservation QR, a voucher, or a game card, and we have to work out which
 * before we know where to send them.
 *
 * TWO classifiers already exist and this module owns the ORDER they run in:
 *
 *   classifyScan       (checkin/scan.ts)      reservation handles
 *   classifyKioskCode  (code-entry/classify.ts) vouchers / cards / promos
 *
 * Neither can be used alone, because BOTH end in a greedy catch-all —
 * `classifyScan` calls anything left over a reservation `code`, and
 * `classifyKioskCode` calls anything left over a `promo`. Run either one first
 * and it swallows the other's payloads:
 *
 *   0000000001063464  game card → classifyScan alone says "shortcode" (16 alnum)
 *   SUMMER26          promo     → classifyScan alone says "shortcode" (8 alnum)
 *   C2D8…R9           BMI vch   → classifyScan alone says "code"      (24 chars)
 *   W56444            booking   → classifyKioskCode alone says "promo"
 *
 * So: MOST-SPECIFIC SHAPE FIRST, greedy catch-alls last. The code-shape
 * classifier runs first but only its *structural* verdicts are honoured
 * (game-card / gift-card / the two voucher shapes); its `promo` catch-all is
 * ignored and the payload falls through to the reservation classifier, whose
 * own catch-all then lands on the ambiguous path.
 *
 * WHAT CANNOT BE DECIDED HERE. An `HPW` voucher is meaningful two ways: one
 * minted at booking carries `vouchers.bill_id` and proves a reservation (the
 * VIP combo QR), while a standalone comp voucher is purely redeemable. That is
 * a database fact, not a code shape, so it becomes `resolve-then-code-entry`:
 * the caller tries the reservation lookup and falls back to the code screen.
 * Bare 6–16-char tokens are ambiguous for the same structural reason and take
 * the same path. Owner decision 2026-08-02: "decide by bill_id".
 */

import { classifyKioskCode } from "../code-entry/classify";
import { classifyScan, shortCodeFromPath } from "../checkin/scan";

export type EntryScanRoute =
  /** A reservation handle that carries its own structure (signed URL, /s link,
   *  W-number). A miss is a real miss — never falls back to the code screen. */
  | { kind: "reservation"; value: string; raw: string }
  /** A voucher or coupon. `KioskCodeEntry` re-classifies the raw payload, so
   *  BMI vouchers, native vouchers and promos all share this destination. */
  | { kind: "code-entry"; value: string; raw: string }
  /** An Intercard game card → Game Zone. `value` is the account number, kept a
   *  STRING (Intercard accounts exceed float-safe ranges upstream). */
  | { kind: "game-card"; value: string; raw: string }
  /** Could be either. Try the reservation lookup; on a miss, open the code
   *  screen with `raw`. Covers HPW vouchers and bare short tokens. */
  | { kind: "resolve-then-code-entry"; value: string; raw: string }
  /** Nothing an entry screen routes. The caller shows a brief toast. */
  | { kind: "unsupported"; reason: UnsupportedReason; raw: string };

/** Why a scan went nowhere — picks the toast copy. */
export type UnsupportedReason =
  /** Square gift card. Out of scope until it has a screen to land on. */
  | "gift-card"
  /** A driver's licence under the scanner. */
  | "license"
  /** Empty, or a payload no classifier recognises. */
  | "unknown";

/**
 * A driver's licence PDF417 — `@\x1e\rANSI 636…`. Same heuristic as
 * gift-card-qr.ts, deliberately: a licence normally arrives as a MULTI-LINE
 * burst that the listener rejects before it ever gets here, so this only
 * catches the single-line case.
 */
function looksLikeLicense(raw: string): boolean {
  return raw.startsWith("@") || raw.includes("ANSI ");
}

export function classifyEntryScan(input: string): EntryScanRoute {
  const raw = (input || "").trim();
  if (!raw) return { kind: "unsupported", reason: "unknown", raw };
  if (looksLikeLicense(raw)) return { kind: "unsupported", reason: "license", raw };

  const isUrl = /^(?:https?:\/\/|sqgc:\/\/)/i.test(raw);

  // ── Pass 1: code shapes. Only STRUCTURAL verdicts are honoured here; the
  // `promo` catch-all deliberately falls through to pass 2 so a W-number or a
  // /s link isn't swallowed as a discount code.
  const code = classifyKioskCode(raw);
  switch (code.kind) {
    case "game-card":
      return { kind: "game-card", value: code.value, raw };
    case "gift-card":
      return { kind: "unsupported", reason: "gift-card", raw };
    case "bmi-voucher":
      // 24 chars of strict letter/digit alternation — cannot be anything else.
      return { kind: "code-entry", value: code.value, raw };
    case "native-voucher":
      // HPW: redeemable, but a booking-minted one also proves a reservation.
      return { kind: "resolve-then-code-entry", value: code.value, raw };
    case "promo":
    case "unknown":
      break; // fall through — pass 2 owns these
  }

  // ── Pass 2: reservation handles.
  //
  // Which string to examine matters. Pass 1 UNWRAPS coupon URLs (`?code=X`)
  // and re-classifies the inner code, so for a URL that came back `promo` the
  // meaningful payload is `code.value`, not the outer URL — feeding the URL to
  // classifyScan would just yield "unknown" and lose the code. For everything
  // else, examine `raw`: classifyKioskCode UPPERCASES its promo output, and
  // the reservationCode index is keyed on the code exactly as issued, so a
  // lowercase `r{billId}` must not be case-folded on the way through.
  const scanInput = isUrl && code.kind === "promo" ? code.value : raw;
  const scan = classifyScan(scanInput);
  switch (scan.kind) {
    case "signed-url":
    case "wnumber":
      return { kind: "reservation", value: scan.value, raw };
    case "shortcode":
      // A code lifted out of a `/s/{code}` PATH is unmistakably one of ours.
      // A BARE 6–16-char token that merely LOOKS like one is not — that shape
      // also fits a promo code, so it has to be resolved before we commit.
      return shortCodeFromPath(scanInput)
        ? { kind: "reservation", value: scan.value, raw }
        : { kind: "resolve-then-code-entry", value: scan.value, raw };
    case "voucher":
      // Pass 1 already caught every HPW form; defensive only.
      return { kind: "resolve-then-code-entry", value: scan.value, raw };
    case "code":
      // The opaque-reservationCode catch-all. Try the booking index, but let a
      // long coupon code that landed here still reach the code screen.
      return { kind: "resolve-then-code-entry", value: scan.value, raw };
    case "unknown":
      return { kind: "unsupported", reason: "unknown", raw };
  }
}
