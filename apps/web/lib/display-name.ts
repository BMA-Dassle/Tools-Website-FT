/**
 * Guest-facing privacy-lean display names — "Eric O." instead of a full name.
 *
 * The established group-event roster pattern (app/event/[slug]/page.tsx
 * makeDisplayName): when guests can see who else is on a heat/reservation,
 * they see first name + last initial only. Full names never leave the server
 * in guest-facing payloads (redaction precedent: session-participants
 * redactIfUntrusted).
 *
 * THE CONTRACT (all four callers depend on it, and one of them puts the result on
 * a link the organizer forwards to the whole party):
 *
 *   1. The output NEVER carries more than a given name and a single initial.
 *   2. The SURNAME field is never a source of a printed WORD — only of an initial,
 *      whatever its token count. There is no input for which a `last` token comes
 *      back in full.
 *   3. MONOTONIC: for every input, the output prints a subset of the words the
 *      pre-2026-07-30 helper printed, and never more tokens. Tightening this rule
 *      can only ever reveal LESS. A "fix" that reveals more for some input class
 *      is a leak wearing a fix's clothes — see the 2026-07-30 II note below.
 *   4. Whitespace-clean: the result is always already trimmed and single-spaced.
 *      Load-bearing for the dedupe key, not cosmetic — see THE KEY below.
 *
 * Both entry points are the same rule (`displayNameFromFull` delegates), so a
 * caller cannot get a different redaction depending on whether BMI handed it one
 * field or two.
 *
 * 2026-07-30 I — this used to be `if (!last) return first`, i.e. it returned the
 * first-name FIELD verbatim, untruncated. BMI's personsByIds profiles routinely
 * carry the whole name in `firstName` with an empty surname, so "Mary Jane
 * Watson-Parker" came straight back out and reached the /waiver roster of a
 * forwardable link. Fixed here, at the shared rule, rather than in one caller.
 *
 * 2026-07-30 II — the first fix over-generalized: it read "only one field is
 * populated" as "that field is the whole name" and re-split it FROM EITHER SIDE,
 * so ("", "Watson Parker") started printing "Watson P." where the old helper had
 * printed just " W.". For that input class the redaction got WEAKER — a full
 * surname reached the forwardable link the fix existed to protect. The rule is now
 * derived from which field a word came from, not from how many tokens it holds:
 * a word may only be printed if it sits in the GIVEN-name field.
 *
 * THE KEY. This output is also the dedupe key between our own Neon rows and BMI's:
 * /api/kiosk/waiver/join WRITES kiosk_waiver_joins.displayName with this helper,
 * /api/{kiosk,}/waiver/* READS BMI profile fields with it, and
 * `unionValidWithJoins` + `buildWaiverRoster` then match the two sides on the
 * LOWERCASED display name (one of them trims first, the other does not — hence
 * contract 4). Redacting one side only, or emitting a stray leading space, splits
 * the key: a guest who already signed is asked to sign again AND appears twice.
 * So the rule stays SHARED and total — never a special case in one caller.
 *
 * Follow-up (not this feature): migrate the event page's local copy to
 * import from here — it still has the old, leaky `if (!l) return f`.
 */

/** Whitespace-normalized name tokens: "  Ann   Alpha " → ["Ann", "Alpha"]. */
function nameTokens(field: string): string[] {
  return (field || "").trim().split(/\s+/).filter(Boolean);
}

/** "Alpha" → "A." — the ONLY form in which a family name is ever printed. */
function initialOf(token: string): string {
  return `${token.charAt(0).toUpperCase()}.`;
}

/** "Eric" + "Osborn" → "Eric O." — see THE CONTRACT above. */
export function makeDisplayName(first: string, last: string): string {
  const given = nameTokens(first);
  const family = nameTokens(last);

  // Nothing in the given-name field, so nothing here is a given name and nothing
  // may be printed in full. A bare surname field — one token or five — reduces to
  // the initial of its first token: "Alpha" → "A.", "Watson Parker" → "W.",
  // "Van Der Berg" → "V.". (No leading space: the old " A." was a truthy,
  // blank-looking name that slipped every caller's `.filter(p => p.displayName)`.)
  if (given.length === 0) return family.length > 0 ? initialOf(family[0]) : "";

  // A given name is printable. For the initial beside it, the surname FIELD wins
  // whenever BMI populated it — and we take its FIRST token, so a two-part surname
  // initials to its own first letter ("Ana" + "García Pérez" → "Ana G.", never
  // "Ana P."). Latino two-surname records are common here and that field boundary
  // is real information.
  //
  // With no surname field, the given field is carrying the whole name, so its LAST
  // token is the family name ("Mary Jane Watson-Parker" → "Mary W."). Either way
  // only an initial survives, so the surname's own token count cannot matter.
  const family1 = family.length > 0 ? family[0] : given.length > 1 ? given[given.length - 1] : "";

  // A single token in the given field and no surname field is a true mononym
  // ("Cher") — there is nothing left to redact.
  return family1 ? `${given[0]} ${initialOf(family1)}` : given[0];
}

/**
 * "Eric Osborn" → "Eric O." — for a name already collapsed into one string.
 * Single tokens pass through unchanged.
 *
 * Delegates so the one-field and two-field paths can never drift apart. It is also
 * IDEMPOTENT on every value `makeDisplayName` can return ("Ann A." → "Ann A.",
 * "A." → "A."), which is what lets ~/features/waiver/roster re-apply it as a
 * boundary guard to names that may already be redacted.
 */
export function displayNameFromFull(fullName: string): string {
  return makeDisplayName(fullName, "");
}
