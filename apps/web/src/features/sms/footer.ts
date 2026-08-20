import type { SendCategory } from "./suppression-policy";

/**
 * The opt-out footer, and the segment arithmetic that decides whether
 * adding it costs money.
 *
 * ── Why this is not just a string concat ────────────────────────────
 *
 * CTIA and TCR expect opt-out instructions on the program's messages, and
 * TCR reject 30890 additionally wants HELP to return brand plus contact.
 * Today exactly ONE outbound template carries a footer
 * (`app/api/group-event/rsvp/route.ts:66`) out of 25 files that call
 * `voxSend`, so the e-ticket, check-in, confirmation, lane-ready and
 * video rails all ship with no opt-out language at all.
 *
 * But the footer costs 38 characters, and SMS bills by 160-character
 * segment. Our own history says that is not cosmetic: the delivery-receipt
 * webhook exists in part because long e-ticket bodies were being REJECTED
 * by the carrier for length (Vox error 4505) on a Mega day. And an unvetted
 * TCR brand is capped at 2,000 T-Mobile segments per DAY across every
 * campaign — doubling the segment count on the highest-volume rail halves
 * the headroom before a busy Saturday silently stops sending.
 *
 * So: append centrally, and MEASURE. `segmentsFor` is exported so the
 * caller can report a body that crossed a boundary rather than quietly
 * paying for two segments.
 */

/**
 * Canonical footer. Leading space so it appends cleanly to a body that
 * ends in punctuation.
 *
 * ── Why HELP is not advertised here (owner, 2026-08-20) ─────────────
 *
 * The earlier form was " Reply STOP to opt out, HELP for help." — 38
 * characters. Measured against one real day of traffic (1,091 messages)
 * that footer cost 2,072 segments, which is OVER the 2,000/day T-Mobile
 * ceiling for an unvetted brand, on a Wednesday. Dropping HELP costs 15
 * characters and takes it to 1,822.
 *
 * Nearly all of that saving is one template: video-match lands at 137
 * characters, so a 23-char footer fits inside one segment and a 38-char
 * one does not — 228 sends going from one segment to two, for fifteen
 * characters of text.
 *
 * The compliance requirement is that HELP WORKS, not that every message
 * advertises it: TCR reject 30890 is about what the HELP reply must
 * contain (brand plus contact), and `inbound-replies.ts` answers it.
 * Guests texting HELP still get a branded reply with a phone number.
 */
export const SMS_OPT_OUT_FOOTER = " Reply STOP to opt out.";

/** GSM-7 single segment. Above this, a message is split. */
const GSM7_SINGLE = 160;
/** Concatenated GSM-7 segments carry a 6-byte UDH, costing 7 characters. */
const GSM7_CONCAT = 153;
/** UCS-2 (any non-ASCII character present) is far smaller. */
const UCS2_SINGLE = 70;
const UCS2_CONCAT = 67;

const NON_GSM7_RE = /[^\x00-\x7F]/;

/**
 * Billable segment count for a body.
 *
 * A single non-ASCII character — a curly apostrophe pasted from a doc, an
 * emoji in a template — drops the budget from 160 to 70 and can triple the
 * segment count of a message that looked fine. That is why this reports
 * the encoding alongside the count.
 */
export function segmentsFor(body: string): {
  segments: number;
  encoding: "gsm7" | "ucs2";
  chars: number;
} {
  const chars = body.length;
  const ucs2 = NON_GSM7_RE.test(body);
  const single = ucs2 ? UCS2_SINGLE : GSM7_SINGLE;
  const concat = ucs2 ? UCS2_CONCAT : GSM7_CONCAT;
  const encoding = ucs2 ? "ucs2" : "gsm7";
  if (chars === 0) return { segments: 0, encoding, chars };
  if (chars <= single) return { segments: 1, encoding, chars };
  return { segments: Math.ceil(chars / concat), encoding, chars };
}

/**
 * Does this body already carry opt-out language?
 *
 * Matched loosely on purpose. The one template that has a footer today
 * says "Reply STOP to opt out."; the retiring promos say "Reply STOP" and
 * "Txt STOP"; the survey templates say "STOP to opt out". Appending ours
 * on top would produce a message telling the guest to reply STOP twice,
 * which reads like a bug and wastes a segment.
 */
export function hasOptOutLanguage(body: string): boolean {
  return /\b(?:reply|txt|text)\s+stop\b|\bstop\s+to\s+opt\s+out\b/i.test(body);
}

export interface FooterResult {
  body: string;
  appended: boolean;
  /** Why the footer was skipped, when it was. */
  skipReason?: "otp" | "already_present" | "empty_body";
  segments: number;
  encoding: "gsm7" | "ucs2";
  chars: number;
  /** True when appending pushed the body across a segment boundary. The
   *  caller should report these — this is the audit signal that tells us
   *  WHICH templates need shortening, from real traffic rather than a
   *  static guess at 40 inline template literals. */
  crossedBoundary: boolean;
}

/**
 * Append the footer where it belongs, and report the cost.
 *
 * Skipped for `"otp"`: a six-digit code the guest requested ten seconds
 * ago is the weakest case for spending 38 characters, and it is the one
 * category that already bypasses suppression — so there is nothing for a
 * STOP to act on there anyway.
 */
export function withOptOutFooter(body: string, category: SendCategory): FooterResult {
  const before = segmentsFor(body);

  const skip = (skipReason: FooterResult["skipReason"]): FooterResult => ({
    body,
    appended: false,
    skipReason,
    segments: before.segments,
    encoding: before.encoding,
    chars: before.chars,
    crossedBoundary: false,
  });

  if (body.trim() === "") return skip("empty_body");
  if (category === "otp") return skip("otp");
  if (hasOptOutLanguage(body)) return skip("already_present");

  const next = body + SMS_OPT_OUT_FOOTER;
  const after = segmentsFor(next);
  return {
    body: next,
    appended: true,
    segments: after.segments,
    encoding: after.encoding,
    chars: after.chars,
    crossedBoundary: after.segments > before.segments,
  };
}
