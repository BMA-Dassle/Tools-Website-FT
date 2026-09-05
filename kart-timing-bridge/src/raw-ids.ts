/**
 * Keep the venue's big integer ids intact across JSON.parse.
 *
 * WHY THIS FILE EXISTS (2026-09-05): `RaceAdvice.Drivers[].PersonId` carries
 * cloud-minted BMI person ids, and those run 17 digits. `JSON.parse` turns them
 * into doubles, and past `Number.MAX_SAFE_INTEGER` a double cannot hold every
 * integer — at ~6.3e16 the gap between representable values is 8. Proved on the
 * real value out of the queue:
 *
 *     Number("63000000009540610")          → prints 63000000009540610
 *     BigInt(Number("63000000009540610"))  → 63000000009540608n
 *
 * The print is the trap: JS renders the SHORTEST decimal that maps back to the
 * same double, so a rounded id looks untouched in a log, in a Redis dump, and in
 * a debugger. Every id in `kart:events:queue` written before this shipped is
 * suspect and cannot be repaired — the digits are simply gone.
 *
 * `RecordVersion` has the same shape (13433235858757000, 17 digits) and is used
 * as a replay guard, where a rounded value silently collides two different
 * events into "we already saw this".
 *
 * THE FIX is the same one the web app uses for BMI and Pandora (`parseWithRawIds`
 * in `@ft/db`): quote the id fields in the RAW TEXT before parsing, so they land
 * as full-precision strings. The bridge cannot import from the monorepo — it is a
 * standalone Railway service with its own package.json — so the rule lives here
 * too. Keep the two in step.
 *
 * A `: string` type annotation does NOT prevent the corruption. Only never
 * letting the digits touch a double does.
 */

/**
 * Every field on the venue wire that is an identifier rather than a quantity.
 *
 * Quoting one that happens to be small is harmless: downstream reads them all as
 * strings, and `String(x)` on an already-quoted value is a no-op. Missing one
 * that turns out to be large is not harmless, so this list errs long.
 *
 * Sourced from a 32h survey of `kart:events:queue` (2026-09-05) covering
 * RaceAdvice, RaceStart/Stop/Finish, every Participant* and Session*
 * notification, TimingPassing, Crash/UnCrash, Assignment, EnterTap and
 * SpeedChange.
 */
export const VENUE_ID_FIELDS = [
  "PersonId",
  "ParticipantId",
  "DriverId",
  "RaceId",
  "SessionId",
  "PassingId",
  "RentalObjectId",
  "KartId",
  "TrapId",
  "ProductId",
  "NotificationMetaId",
  "RecordVersion",
  "Id",
] as const;

/**
 * `JSON.parse`, with the id fields above preserved as exact digit strings.
 *
 * The regex only matches an UNQUOTED number after the colon, so a field the
 * venue already sends as a string is left alone and re-quoting is impossible.
 * Negative values (`ResourceId: -1` is Mega, and `NotificationMetaId` is always
 * negative) are matched too — the sign is carried into the string.
 *
 * Throws exactly what `JSON.parse` throws, so callers keep their existing
 * try/catch semantics.
 */
export function parseVenueJson<T = unknown>(
  text: string,
  idFields: readonly string[] = VENUE_ID_FIELDS,
): T {
  let out = text;
  for (const field of idFields) {
    const re = new RegExp(`("${field}"\\s*:\\s*)(-?\\d+)`, "g");
    out = out.replace(re, '$1"$2"');
  }
  return JSON.parse(out) as T;
}
