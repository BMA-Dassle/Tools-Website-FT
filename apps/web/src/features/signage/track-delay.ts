/**
 * IS THIS TRACK RUNNING TO TIME? PURE — the venue's delay figure in, a verdict
 * out.
 *
 * Three surfaces already answer this and each answers it slightly differently:
 * the pit wall prints "On time" or "+4 min", the check-in wall says "Running 4
 * min behind", and the desk board buried it in the unit line under a number
 * (owner 2026-08-16: "add on time and not on time here please on check in
 * board"). The words are the smallest part; what matters is the third state.
 *
 * UNKNOWN IS NOT ON TIME. The desk board read a missing track as punctual — the
 * delay figure comes from the venue feed, and a track absent from it produced a
 * dash beside the words "on time", which is a claim nobody made. A board that
 * says a track is fine when it has no idea is worse than one that says nothing,
 * because staff stop checking. So the absent case is its own verdict and prints
 * as such.
 */

export interface TrackDelay {
  delayMinutes: number;
  /** The venue's own wording ("4 min"), when it sends one. */
  delayFormatted?: string;
}

export type Punctuality =
  | { state: "on-time"; label: string; minutes: 0 }
  | { state: "late"; label: string; minutes: number }
  | { state: "unknown"; label: string; minutes: null };

/**
 * `delay` is whatever the track feed had for this track, or null when it had
 * nothing. Negative minutes — a track somehow ahead of itself — read as on time
 * rather than as "-3 min late", which is not a thing anyone says.
 */
export function punctuality(delay: TrackDelay | null | undefined): Punctuality {
  if (!delay || !Number.isFinite(delay.delayMinutes)) {
    return { state: "unknown", label: "No delay reading", minutes: null };
  }
  const minutes = Math.round(delay.delayMinutes);
  if (minutes <= 0) return { state: "on-time", label: "On time", minutes: 0 };
  const how = delay.delayFormatted?.trim() || `${minutes} min`;
  return { state: "late", label: `${how} behind`, minutes };
}
