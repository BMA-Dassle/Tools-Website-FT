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
