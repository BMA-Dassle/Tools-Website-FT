/**
 * Shorten a full name to "First L." for QAMF lane display (the name
 * shown on the bowling scoreboard). Used by KBF flows only — open
 * bowling sends the guest-entered name verbatim.
 *
 *   "Ada Lovelace"   -> "Ada L."
 *   "Ada"            -> "Ada"
 *   "  Mary  Anne K" -> "Mary K."
 *   ""               -> ""
 */
export function toLaneInsertName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const last = parts[parts.length - 1];
  return `${first} ${last[0].toUpperCase()}.`;
}
