/**
 * Person-input normalization for the kiosk (owner 2026-07-19: "stop the all
 * caps — first letter of each name caps, emails all lowercase").
 *
 * Names arrive ugly from two directions: guests shift-typing on the OSK, and
 * CRM records (BMI Office / Pandora) that store legacy people in ALL CAPS.
 * formatPersonName fixes both without stomping deliberate mixed case: a
 * single-cased token ("JOHN", "john") is title-cased, while a mixed-case
 * token ("McDonald", "DiMaggio") keeps its interior caps and only ensures
 * the leading capital. Hyphen/apostrophe segments each get their own capital
 * ("mary-jane o'brien" → "Mary-Jane O'Brien").
 */

function capSegment(seg: string): string {
  if (!seg) return seg;
  const hasLower = /\p{Ll}/u.test(seg);
  const hasUpper = /\p{Lu}/u.test(seg);
  const body = hasLower && hasUpper ? seg.slice(1) : seg.slice(1).toLowerCase();
  return seg.charAt(0).toUpperCase() + body;
}

/** "JOHN SMITH" → "John Smith"; "mary-jane o'brien" → "Mary-Jane O'Brien". */
export function formatPersonName(raw: string): string {
  return (raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) =>
      word
        .split(/([-'’])/)
        .map((seg) => (seg === "-" || seg === "'" || seg === "’" ? seg : capSegment(seg)))
        .join(""),
    )
    .join(" ");
}

/** Emails are stored lowercase — the OSK's smart-caps was landing "John@…". */
export function normalizeEmail(raw: string): string {
  return (raw ?? "").trim().toLowerCase();
}
