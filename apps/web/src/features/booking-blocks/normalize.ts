/**
 * Identity normalization for the block list — PURE, no I/O, so it is the same
 * on the write path (adding a block) and the read path (checking one). A block
 * that stores "SJorvelus@Gmail.com " and a booking that types
 * "sjorvelus@gmail.com" must match, or the list silently does nothing.
 */
import type { BlockKind } from "./types";

/** Every kind a block row may use. Lives here, next to normalizeValue's switch,
 *  so the list and the per-kind rule can never drift apart. */
export const BLOCK_KINDS: readonly BlockKind[] = [
  "email",
  "phone",
  "square_customer",
  "bmi_person",
  "card_fingerprint",
] as const;

/** Lowercase + trim. Deliberately does NOT strip Gmail dots or +tags: those are
 *  different addresses to Square and to our own mailer, and over-normalizing
 *  would block third parties who merely look similar. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  return v.includes("@") && v.length <= 320 ? v : null;
}

/**
 * Digits only, then the last 10 (NANP subscriber number). This is what makes
 * "+1 239-851-2480", "2398512480" and "(239) 851-2480" one value — our own data
 * holds all three shapes for the same guest (`guest_phone` is bare digits,
 * Square is E.164, the POV log is +1-prefixed).
 *
 * Anything shorter than 10 digits is rejected rather than stored short: a
 * 4-digit value would match far too much.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

/** Square ids and card fingerprints are opaque and case-sensitive — trim only. */
export function normalizeOpaque(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  return v.length > 0 && v.length <= 256 ? v : null;
}

/** BMI/Office person id: digits only, never Number()'d (ids exceed
 *  MAX_SAFE_INTEGER on some centers — the repo-wide precision rule). */
export function normalizePersonId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  return /^\d{1,25}$/.test(v) ? v : null;
}

/** Normalize by kind — the single switch both paths go through. */
export function normalizeValue(kind: BlockKind, raw: string | null | undefined): string | null {
  switch (kind) {
    case "email":
      return normalizeEmail(raw);
    case "phone":
      return normalizePhone(raw);
    case "bmi_person":
      return normalizePersonId(raw);
    case "square_customer":
    case "card_fingerprint":
      return normalizeOpaque(raw);
    default: {
      // Exhaustiveness: a new BlockKind must be handled here, not silently pass.
      const never: never = kind;
      throw new Error(`normalizeValue: unhandled kind ${String(never)}`);
    }
  }
}

/**
 * One physical complex has TWO names in this codebase: a Neon CenterCode
 * ("fort-myers") and a BMI Office client key ("headpinzftmyers"). A block row
 * written from an Office context and a booking arriving from a Neon context must
 * still match, so both collapse to one canonical token here.
 *
 * Without this the `bmi_person` rows (stored as "headpinzftmyers") would never
 * match the reserve path (which passes "fort-myers") — a block list that looks
 * configured and silently does nothing.
 *
 * FastTrax Fort Myers and HeadPinz Fort Myers share the "fort-myers" complex,
 * which is exactly right for a companywide ban.
 */
const CENTER_ALIASES: Record<string, string> = {
  "fort-myers": "fort-myers",
  fortmyers: "fort-myers",
  fasttrax: "fort-myers",
  headpinzftmyers: "fort-myers",
  naples: "naples",
  headpinznaples: "naples",
};

export function normalizeCenter(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  // Unknown centers pass through case-folded rather than being dropped: a new
  // center must not silently become "matches everything".
  return CENTER_ALIASES[v] ?? v;
}
