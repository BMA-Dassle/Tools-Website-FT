/**
 * Track identity for the racing screens. PURE.
 *
 * FastTrax has two tracks — Blue and Red — and on Tuesdays the barrier between
 * them comes out and they run as ONE 2,108 ft circuit called Mega. That is not
 * a pairing of two tracks in the data: Mega is its own resource (`-1`), and on a
 * Mega day Pandora reports `blue` and `red` as null with only `mega` populated.
 *
 * Which means the two track TVs "acting as one" on a Mega race is a
 * presentation decision, not a data-merging problem — they are already reading
 * the same session. See megaPairing() below.
 */

export type TrackKey = "blue" | "red" | "mega";

/** BMI/Office resource ids, matching features/daily-events/constants.ts. */
export const TRACK_RESOURCE_IDS: Record<TrackKey, string> = {
  blue: "11208654",
  red: "11208660",
  mega: "-1",
};

/** Track identity colours, matching the racing surfaces already in production. */
export const TRACK_ACCENTS: Record<TrackKey, string> = {
  blue: "#004aad",
  red: "#e53935",
  mega: "#8652ff",
};

export const TRACK_LABELS: Record<TrackKey, string> = {
  blue: "Blue Track",
  red: "Red Track",
  mega: "Mega Track",
};

const BY_RESOURCE: Record<string, TrackKey> = {
  "11208654": "blue",
  "11208660": "red",
  "-1": "mega",
};

/** Which track a screen speaks for, from its config scope. Null = not a track
 *  screen (a lobby TV), which is a legitimate answer, not a failure. */
export function trackFromResourceIds(resourceIds: string[] | undefined): TrackKey | null {
  if (!resourceIds) return null;
  for (const id of resourceIds) {
    const t = BY_RESOURCE[id];
    if (t) return t;
  }
  return null;
}

/** Track from any name Pandora or BMI might use ("Blue Track", "Starter Race
 *  Blue", "Mega"). Mirrors trackKeyFromName in reservations-admin. */
export function trackFromName(name: string | null | undefined): TrackKey | null {
  if (!name) return null;
  const m = /\b(red|blue|mega)\b/i.exec(name);
  return m ? (m[1].toLowerCase() as TrackKey) : null;
}

/**
 * Which track's session this screen should show right now.
 *
 * On a Mega day the screen's own track has no session at all — the racing has
 * moved to the combined circuit — so a Blue screen must follow Mega or it would
 * sit blank on the busiest day of the week.
 */
export function effectiveTrack(
  screenTrack: TrackKey | null,
  megaEnabled: boolean,
): TrackKey | null {
  if (megaEnabled) return "mega";
  return screenTrack;
}

/**
 * Is this screen part of a Mega-day pair, and where does it stand?
 *
 * When both track screens are showing the same combined session, they stop
 * being two independent displays: `position` lets each take one half of a
 * single composition, derived from the shared clock exactly the way the kiosk
 * bank's billboard is. Returns null when the screen is on its own.
 */
export function megaPairing(
  pairing: { groupId: string; position: number; count: number } | null,
  megaEnabled: boolean,
): { position: number; count: number } | null {
  if (!megaEnabled || !pairing || pairing.count < 2) return null;
  return { position: pairing.position, count: pairing.count };
}
