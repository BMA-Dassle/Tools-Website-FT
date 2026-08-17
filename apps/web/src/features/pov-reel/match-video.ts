import { normalizeName, namePartsOf } from "~/features/kiosk/checkin/roster-merge";

/** Just the two name fields — structural, so this module needs no video import. */
export interface NamedVideo {
  firstName?: string;
  lastName?: string;
}

/**
 * Does this video belong to this racer?
 *
 * The timing system's `ParticipantName` is what a human typed at a kiosk and is
 * routinely ABBREVIATED — "Genn A" for "Genn Alvarez" — while a VideoMatch
 * carries a full first and last name from Pandora. An exact compare would
 * silently drop a large share of real pairs.
 *
 * Narrow on purpose, because a wrong match puts the wrong person's footage on a
 * public wall: forenames must be EQUAL, and the surname must be equal or be a
 * genuine PREFIX of the other, which is what an abbreviation is. A missing
 * surname on either side is not a match — "Genn" alone cannot be told apart from
 * a different Genn in the same heat.
 *
 * Prefix matching is inherently ambiguous ("Genn A" fits both Alvarez and
 * Anderson), so callers must require exactly one hit per session and exclude the
 * racer otherwise. That fail-closed step lives at the call site, not here.
 */
export function racerMatchesVideo(participantName: string, m: NamedVideo): boolean {
  const a = namePartsOf(participantName);
  const b = namePartsOf(normalizeName(`${m.firstName ?? ""} ${m.lastName ?? ""}`));
  if (!a.first || !b.first || a.first !== b.first) return false;
  if (!a.last || !b.last) return false;
  if (a.last === b.last) return true;
  return b.last.startsWith(a.last) || a.last.startsWith(b.last);
}
