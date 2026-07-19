/**
 * Guest-facing privacy-lean display names — "Eric O." instead of a full name.
 *
 * The established group-event roster pattern (app/event/[slug]/page.tsx
 * makeDisplayName): when guests can see who else is on a heat/reservation,
 * they see first name + last initial only. Full names never leave the server
 * in guest-facing payloads (redaction precedent: session-participants
 * redactIfUntrusted).
 *
 * Follow-up (not this feature): migrate the event page's local copy to
 * import from here.
 */

/** "Eric" + "Osborn" → "Eric O." — empty last name passes the first through. */
export function makeDisplayName(first: string, last: string): string {
  const f = (first || "").trim();
  const l = (last || "").trim();
  if (!l) return f;
  return `${f} ${l.charAt(0).toUpperCase()}.`;
}

/** "Eric Osborn" → "Eric O."; single-token names pass through unchanged. */
export function displayNameFromFull(fullName: string): string {
  const parts = (fullName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return makeDisplayName(parts[0], parts[parts.length - 1]);
}
