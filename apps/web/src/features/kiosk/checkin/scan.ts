/**
 * Pure classification of a "find my reservation" scan/typed payload.
 *
 * A guest presents one of several things at the kiosk: the /s short link from
 * their email/SMS, a full signed confirmation URL, a typed W-number, the
 * `r{billId}` fallback code, or BMI's native reservationCode. This module only
 * CLASSIFIES the raw string (no I/O) — resolution to a billId happens in the
 * server module, which needs Redis. Kept pure so it's unit-testable and safe to
 * reuse client-side for input hints.
 *
 * Note the wedge parsers in card-reader/wedge.ts are magstripe/digit-oriented
 * and would mangle a scanned URL — the check-in scanner needs THIS parser, not
 * those.
 */

export type ScanKind =
  | "shortcode" // /s/{code} link, a bare short code, or a full URL with a short code
  | "signed-url" // full confirmation URL carrying billId= + sig=
  | "wnumber" // W#####
  | "code" // opaque reservationCode (incl. the r{billId} fallback) — resolved via index, OTP-gated
  | "unknown";

export interface ScanClass {
  kind: ScanKind;
  /** The extracted handle: short code, W-number (upper), raw billId, or code. */
  value: string;
  /** For signed-url only: the sig to verify against the billId. */
  sig?: string;
}

const SHORT_CODE_RE = /^[A-Za-z0-9_-]{6,16}$/;
const W_RE = /^W\d{3,}$/i;

/** Pull the short code out of a `/s/{code}` path (handles full URLs + bare). */
export function shortCodeFromPath(input: string): string | null {
  const m = /\/s\/([A-Za-z0-9_-]{4,32})/.exec(input);
  return m ? m[1] : null;
}

export function classifyScan(raw: string): ScanClass {
  const text = (raw || "").trim();
  if (!text) return { kind: "unknown", value: "" };

  // A URL — either a /s short link or a full signed confirmation URL.
  if (/^https?:\/\//i.test(text) || text.includes("/s/") || text.includes("billId=")) {
    const shortCode = shortCodeFromPath(text);
    if (shortCode) return { kind: "shortcode", value: shortCode };
    // Full confirmation URL with an inline billId + sig.
    try {
      const url = new URL(text, "https://kiosk.local");
      const billId = url.searchParams.get("billId") || url.searchParams.get("orderId");
      const sig = url.searchParams.get("sig") || undefined;
      if (billId && /^\d{15,19}$/.test(billId)) {
        return { kind: "signed-url", value: billId, sig };
      }
    } catch {
      /* not a parseable URL — fall through */
    }
    return { kind: "unknown", value: text };
  }

  if (W_RE.test(text)) return { kind: "wnumber", value: text.toUpperCase() };

  // Ambiguous short token: could be a /s short code OR a native reservationCode.
  // The server tries the short-link key (which carries a verifiable signature)
  // first, then the code index.
  if (SHORT_CODE_RE.test(text)) return { kind: "shortcode", value: text };

  // Anything else non-empty — an r{billId} fallback code, a bare id run, or an
  // opaque native reservationCode — is treated as a CODE: resolved via the
  // issued-code index, never trusted as possession on its own. Because billIds
  // are enumerable, the route OTP-gates any code/W# resolution (only the
  // signature-carrying short-link / signed-URL paths open directly).
  return { kind: "code", value: text };
}
