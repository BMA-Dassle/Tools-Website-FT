/**
 * USB keyboard-wedge capture parsing — the CRT-591-(R02)HB-HDN unit reads
 * cards over a SEPARATE USB interface (the COM port only drives the
 * transport/dispenser). A wedge-mode reader "types" the track data; this
 * parses an ISO 7811 burst into tracks and a best-guess card number.
 *
 * PCI note (mirrors config.ts): this is for Intercard GAME cards — never
 * point it at payment cards; raw payment-track parsing is banned house-wide.
 */

export interface WedgeTracks {
  /** %…? — alphanumeric track. */
  track1: string | null;
  /** ;…? — numeric track (PAN=extra fields split on "="). */
  track2: string | null;
  /** Second ;…?/+…? burst when present. */
  track3: string | null;
}

export interface WedgeCapture {
  raw: string;
  tracks: WedgeTracks;
  /** Best guess at the card/account number for game-card lookup. */
  cardNumber: string | null;
}

/**
 * Parse one captured burst. Tolerates any subset of tracks, missing end
 * sentinels (some wedges strip them), and bare-digit reads (some wedges are
 * configured to emit just the account number).
 */
export function parseWedgeBurst(raw: string): WedgeCapture {
  const text = raw.replace(/[\r\n]+/g, "").trim();
  const tracks: WedgeTracks = { track1: null, track2: null, track3: null };

  const t1 = /%([^?%;]*)\??/.exec(text);
  if (t1) tracks.track1 = t1[1].trim() || null;

  const semis = [...text.matchAll(/;([^?;%]*)\??/g)].map((m) => m[1].trim()).filter(Boolean);
  if (semis[0]) tracks.track2 = semis[0];
  if (semis[1]) tracks.track3 = semis[1];
  if (!tracks.track3) {
    const t3 = /\+([^?%;+]*)\??/.exec(text);
    if (t3) tracks.track3 = t3[1].trim() || null;
  }

  return { raw: text, tracks, cardNumber: bestCardNumber(text, tracks) };
}

/**
 * Intercard corp prefix: a Game Zone card's track 2 is `;6283=<account>?`,
 * and that is what a serial-COM swipe MSR streams (one burst per swipe).
 */
export const INTERCARD_TRACK2_PREFIX = ";6283=";

/**
 * Parse one serial-MSR swipe burst into an Intercard account number.
 * STRICT on the `;6283=` corp prefix: any burst without it — a bank card, a
 * gift card, line noise — returns null and the raw data is for discarding
 * (PCI house rule: payment tracks are never parsed or retained). The account
 * keeps its leading zeros to match the CRT-591 mag-read path (track 2's
 * 16-digit field is the account, confirmed on hardware 2026-07-17).
 */
export function parseIntercardSwipe(raw: string): string | null {
  const text = raw.replace(/[\r\n]+/g, "").trim();
  const m = /;6283=(\d{4,});?\??/.exec(text);
  return m ? m[1] : null;
}

/** What a swipe turned out to be in the Square-gift MSR mode. */
export type SquareGiftSwipe = { kind: "candidate"; gan: string } | { kind: "gamezone" };

/**
 * Parse one serial-MSR swipe burst into a Square gift-card GAN candidate
 * (split-tender flow, plan §7 hardware). Guardrails, in order:
 *
 *  1. Must look like ONE clean track burst — a `;`-led track or a bare
 *     alphanumeric run with optional `=`-field / `?` chrome. Anything else
 *     (track-1 `%…` leads, multi-track bursts, noise) is discarded.
 *  2. HARD bank-card discard FIRST: a would-be PAN of 13–19 digits that is
 *     Luhn-valid AND sits in a payment-network IIN range is a bank card —
 *     return null, never parsed further, never logged (PCI house rule).
 *     Luhn alone is NOT bank-shaped: Square GANs are often Luhn-valid; only
 *     the IIN ranges condemn a number.
 *  3. An Intercard `;6283=` burst is a real card, just the wrong kind —
 *     reported so the UI can say "that's a Game Zone card".
 *  4. A surviving 8–20 char alphanumeric run is a candidate. The server GAN
 *     lookup is the final validator — a non-Square number simply isn't found.
 *
 * This module does no logging at all: neither the raw burst nor the candidate
 * may ever hit a console or a log line.
 */
export function parseSquareGiftSwipe(raw: string): SquareGiftSwipe | null {
  const text = raw.replace(/\s+/g, "");
  if (!text) return null;

  // Intercard detection FIRST, searched anywhere — real hardware can emit
  // track 1 + track 2 in ONE chunk ("%P6283=…?;6283=…?"), which fails the
  // single-track shape gate below; the "that's a Game Zone card" help copy
  // must not depend on chunk timing (review 2026-07-29).
  if (text.includes(INTERCARD_TRACK2_PREFIX)) return { kind: "gamezone" };

  const body = text.startsWith(";") ? text.slice(1) : text;
  const shape = /^([A-Za-z0-9]+)(?:=[A-Za-z0-9]*)*\??$/.exec(body);
  if (!shape) return null;
  const field = shape[1];

  // Bank-card discard BEFORE anything can treat the run as a candidate.
  const pan = /^\d+/.exec(field)?.[0] ?? "";
  if (pan.length >= 13 && pan.length <= 19 && luhnValid(pan) && isPaymentIin(pan)) return null;

  return field.length >= 8 && field.length <= 20 ? { kind: "candidate", gan: field } : null;
}

/** Standard mod-10 checksum. Caller guarantees digits only. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Payment-network IIN prefixes: Visa, Mastercard (incl. 2-series), Amex,
 * Discover, JCB, Diners. Deliberately a DENYLIST of bank ranges rather than a
 * Square allowlist — Square's gift IINs aren't captured yet (tighten to an
 * allowlist after a live hardware capture, per the split-payments plan §7).
 * Caller guarantees 13+ digits, so the prefix slices are always full-length.
 */
function isPaymentIin(pan: string): boolean {
  const p2 = Number(pan.slice(0, 2));
  const p3 = Number(pan.slice(0, 3));
  const p4 = Number(pan.slice(0, 4));
  if (pan.startsWith("4")) return true; // Visa
  if (p2 >= 51 && p2 <= 55) return true; // Mastercard
  if (p4 >= 2221 && p4 <= 2720) return true; // Mastercard 2-series
  if (p2 === 34 || p2 === 37) return true; // Amex
  if (p4 === 6011 || p2 === 65 || (p3 >= 644 && p3 <= 649)) return true; // Discover
  if (p2 === 35) return true; // JCB
  if ((p3 >= 300 && p3 <= 305) || p2 === 36 || p2 === 38) return true; // Diners
  if (p2 === 62) return true; // UnionPay (incl. Discover-network 622126-622925)
  if (p4 >= 2200 && p4 <= 2204) return true; // Mir
  if (p4 === 5018 || p4 === 5020 || p4 === 5038 || p4 === 6304) return true; // Maestro
  if (p4 === 6759 || (p4 >= 6761 && p4 <= 6763)) return true; // Maestro UK
  return false;
}

function bestCardNumber(text: string, tracks: WedgeTracks): string | null {
  // Track 2's PAN (before "=") is the canonical machine-readable number.
  if (tracks.track2) {
    const pan = tracks.track2.split("=")[0].replace(/\D/g, "");
    if (pan.length >= 4) return pan;
  }
  // Track 1: %B<PAN>^NAME^… or plain content — take the leading digit run.
  if (tracks.track1) {
    const pan = /^[A-Za-z]?(\d{4,19})/.exec(tracks.track1);
    if (pan) return pan[1];
  }
  // Bare read: the longest digit run anywhere in the burst.
  const runs = text.match(/\d{4,}/g);
  if (runs && runs.length) return runs.reduce((a, b) => (b.length > a.length ? b : a));
  return null;
}
