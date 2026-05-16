/**
 * BMI ID precision-safe JSON serialization.
 *
 * BMI Leisure's API uses 17-digit numeric IDs (e.g. 63000000000021716) for
 * personId, orderId, and orderItemId. These exceed JavaScript's
 * Number.MAX_SAFE_INTEGER (9007199254740991). Any roundtrip through Number()
 * or JSON.stringify() silently corrupts them — `Number("63000000000021716")`
 * becomes `63000000000021720`, which then either fails an FK constraint
 * inside BMI or worse, looks up the wrong person.
 *
 * `stringifyWithRawIds` replaces `JSON.stringify` for any HTTP body that
 * carries a BMI ID. It builds the JSON with `JSON.stringify` for the
 * non-ID fields, then string-injects the raw ID values as numeric
 * tokens at the top level of the resulting JSON object.
 *
 * Pattern is the same one `bookRaceHeat()` has used by hand since
 * 2026-04-04 (see tasks/lessons.md "BMI ID Precision"). This helper
 * centralizes it, makes it typed, and lets us lint-enforce
 * `JSON.stringify` bans on BMI-touching files in a follow-up PR.
 *
 * Constraints:
 * - Raw-ID injection happens at the TOP LEVEL of the output object only.
 *   Nested objects must not contain BMI IDs; if a payload needs nested
 *   IDs, refactor the API to use a flat shape.
 * - Each raw ID must be a string of digits (validated). A non-digit
 *   string would let an attacker inject arbitrary JSON.
 * - Field order matches the original v1 pattern: existing `orderId`
 *   prepends to the body, `personId` appends. This is preserved for
 *   snapshot-test compatibility with `bookRaceHeat()`.
 */

export type RawIdMap = Record<string, string>;

const DIGITS = /^\d+$/;

function assertDigits(field: string, value: string): void {
  if (!DIGITS.test(value)) {
    throw new Error(
      `stringifyWithRawIds: rawIds.${field} must be a string of digits, got: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Produce a JSON string with the listed raw-ID fields injected as
 * literal numeric tokens (not JS-stringified Numbers).
 *
 * @param payload  The "body" payload — anything that JSON.stringify
 *                 would handle, minus the raw-ID fields.
 * @param opts.rawIds  Map of field name → digit-only string. Order:
 *                     "orderId" prepends; every other field appends.
 *                     This mirrors the bookRaceHeat() body shape so
 *                     existing BMI consumers receive bit-identical
 *                     JSON.
 */
export function stringifyWithRawIds(
  payload: Record<string, unknown>,
  opts: { rawIds: RawIdMap },
): string {
  const { rawIds } = opts;

  // Validate every raw id is a digit string first — fail loud, never
  // produce a body that could be ambiguous downstream.
  for (const [field, value] of Object.entries(rawIds)) {
    assertDigits(field, value);
  }

  let body = JSON.stringify(payload);

  // bookRaceHeat() prepends orderId and appends personId. Preserve
  // that order so the snapshot stays stable. Any other raw-id fields
  // append after personId.
  const orderId = rawIds.orderId;
  if (orderId !== undefined) {
    body = `{"orderId":${orderId},` + body.slice(1);
  }

  for (const [field, value] of Object.entries(rawIds)) {
    if (field === "orderId") continue;
    body = body.slice(0, -1) + `,"${field}":${value}}`;
  }

  return body;
}
