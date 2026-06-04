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

/**
 * Default set of BMI/Pandora ID field names that must survive parsing as
 * full-precision strings. These are the 17-digit identifiers that exceed
 * Number.MAX_SAFE_INTEGER; every one is typed as `string` throughout the app.
 */
export const BMI_ID_FIELDS = [
  "id",
  "personId",
  "personID",
  "orderId",
  "orderItemId",
  "billId",
  "billLineId",
  "reservationId",
  "projectId",
  "guardianID",
] as const;

/**
 * The INBOUND counterpart to `stringifyWithRawIds`.
 *
 * `JSON.parse` (and `Response.json()`, which uses it) silently rounds any
 * unquoted integer above Number.MAX_SAFE_INTEGER — a 17-digit BMI id like
 * `63000000003675359` is read back as `63000000003675360` (+1). A TypeScript
 * annotation of `string` does NOT prevent this: the runtime value is a rounded
 * `number`. The corruption happens the instant the body is parsed, BEFORE any
 * outbound `stringifyWithRawIds` protection can run — so reading the response
 * losslessly is the only fix.
 *
 * `parseWithRawIds` pre-quotes the numeric values of the named id fields in the
 * raw JSON TEXT, then `JSON.parse`s. The quoted values come back as strings,
 * preserving every digit. This is the generalized form of the `res.text()` +
 * regex pattern already used by `bookRaceHeat()` / `extractRawOrderId`.
 *
 * Constraints / behavior:
 * - Only the LISTED fields are quoted; all other JSON is untouched. Pass a
 *   custom `idFields` to cover endpoint-specific names.
 * - Values already quoted by the source (some BMI endpoints return string ids)
 *   are left as-is — a `"` follows the colon, so the numeric branch never matches.
 * - These fields are always identifiers, so quoting even a small value is safe
 *   (downstream types them as `string`).
 * - Like the existing `extractRawOrderId` regex, this matches on the raw text.
 *   A string VALUE that embeds an escaped, fully-quoted `"orderId":123` token
 *   could in theory be rewritten; BMI/Pandora payloads don't produce that shape,
 *   and the risk is identical to the regex pattern already relied on in `data.ts`.
 *
 * @param jsonText  Raw response text (use `await res.text()`, never `res.json()`).
 * @param idFields  Id field names to preserve. Defaults to {@link BMI_ID_FIELDS}.
 */
export function parseWithRawIds<T = unknown>(
  jsonText: string,
  idFields: readonly string[] = BMI_ID_FIELDS,
): T {
  let text = jsonText;
  for (const field of idFields) {
    // "field": 633...  ->  "field": "633..."
    // The trailing `(\d+)` only matches an UNQUOTED number, so an id the source
    // already quoted (a `"` after the colon) is skipped.
    const re = new RegExp(`("${field}"\\s*:\\s*)(\\d+)`, "g");
    text = text.replace(re, '$1"$2"');
  }
  return JSON.parse(text) as T;
}

/**
 * Inverse of {@link parseWithRawIds}, for the read-modify-write pattern against
 * BMI Office endpoints (GET a project → change one field → PUT it back).
 *
 * After `parseWithRawIds`, an object's id fields are full-precision STRINGS.
 * `JSON.stringify` would then emit them as `"id":"633..."` (quoted), but BMI's
 * project endpoints emit — and validate against — RAW NUMERIC tokens. This
 * re-emits the listed id fields as raw numbers, producing a body byte-faithful
 * to what the GET returned (minus whatever non-id field you intentionally
 * changed). Precision is never lost: the digits came from a string, not a
 * rounded `number`.
 *
 * Unlike {@link stringifyWithRawIds} (which injects a fixed set of top-level ids
 * onto a payload), this rewrites EVERY occurrence, including nested ids such as
 * `persons[].id` or `logs[].id`.
 *
 * @param obj       Object whose id fields are digit strings (e.g. from parseWithRawIds).
 * @param idFields  Id field names to re-emit as numbers. Defaults to {@link BMI_ID_FIELDS}.
 */
export function serializeWithRawIds(
  obj: unknown,
  idFields: readonly string[] = BMI_ID_FIELDS,
): string {
  let body = JSON.stringify(obj);
  for (const field of idFields) {
    // "field":"633..."  ->  "field":633...   (null / non-digit values untouched)
    const re = new RegExp(`("${field}"\\s*:\\s*)"(\\d+)"`, "g");
    body = body.replace(re, "$1$2");
  }
  return body;
}
