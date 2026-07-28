/**
 * Is an email address structurally deliverable? One predicate, used by every
 * layer of the booking path.
 *
 * Born from a real orphan (2026-07-28): a guest typed
 * `natalietorres1732@gmail.com@` on an iPhone — the address plus one stray `@`
 * from the `type="email"` keyboard. Nothing in the chain objected:
 *
 *   - `<input type="email">` never validates outside a submitted <form>, and the
 *     checkout has no <form> — so the browser never looked at it.
 *   - the Pay gate asked `email.includes("@")`, which two `@`s satisfy.
 *   - the reserve route asked `!body.contact?.email` — truthiness only.
 *   - BMI stored it verbatim; Square never reads it.
 *   - QAMF, the ONLY party with a real validator, rejected it with
 *     `400 Customer.Guest.Email: "Value is not a valid Email."` — AFTER we had
 *     captured $346.12. The booking died holding the guest's money.
 *
 * So the rule is: whatever the strictest downstream vendor will accept, we
 * accept — and we decide BEFORE the charge, never after.
 *
 * Deliberately stricter than the WHATWG `type="email"` regex in one way (a dot
 * in the domain is required, because `a@b` is not deliverable) and no looser in
 * any way. Returns a machine-readable reason CODE rather than copy: the kiosk
 * must render its own translated string (EN+ES hard rule), so this module never
 * decides wording.
 *
 * Normalization lives next door in `./name-format` (`normalizeEmail` — trim +
 * lowercase). Validate the raw input, store the normalized form.
 */

/**
 * Local part, then a domain of dot-separated LDH labels.
 *
 * Local:  RFC 5322 atext, dot-separated, so no leading/trailing/doubled dot.
 * Domain: each label starts and ends alphanumeric (hyphens only inside), and at
 *         least one dot is mandatory.
 *
 * A second `@` cannot match: it is absent from both the local charset and the
 * domain label charset. That single property is what this whole module exists
 * for — see the header.
 */
const EMAIL_RE =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Why an address was refused. Callers own the wording. */
export type EmailRejection =
  | "empty"
  | "too-long"
  | "local-too-long"
  | "not-one-at"
  | "tld-too-short"
  | "malformed";

/** RFC 5321 caps: 254 for the whole address, 64 for the local part. */
const MAX_EMAIL = 254;
const MAX_LOCAL = 64;

/**
 * The reason this address is not deliverable, or null when it is.
 *
 * Checks are ordered cheapest-and-most-specific first so the code returned is
 * the most useful one to explain: "not-one-at" beats a bare "malformed" for the
 * exact input that caused the incident.
 */
export function emailRejection(raw: string | null | undefined): EmailRejection | null {
  const email = (raw ?? "").trim();
  if (!email) return "empty";
  if (email.length > MAX_EMAIL) return "too-long";

  const firstAt = email.indexOf("@");
  if (firstAt < 1 || email.indexOf("@", firstAt + 1) !== -1) return "not-one-at";
  if (firstAt > MAX_LOCAL) return "local-too-long";

  if (!EMAIL_RE.test(email)) return "malformed";

  // ICANN requires >= 2 characters; a 1-char TLD is a typo, never a real host.
  const domain = email.slice(firstAt + 1);
  if (domain.length - domain.lastIndexOf(".") - 1 < 2) return "tld-too-short";

  return null;
}

/**
 * True when this address is structurally deliverable AND acceptable to every
 * vendor we hand it to. Use this for any gate in front of a charge — a button's
 * disabled state, a zod refinement, a pre-charge server guard.
 */
export function isDeliverableEmail(raw: string | null | undefined): boolean {
  return emailRejection(raw) === null;
}
