/**
 * The lane-ready cache contract — one key shape, one TTL, one parser.
 *
 * The `bowling-lane-ready` cron WRITES this and the TV feed READS it, and they are in
 * different runtimes, so the shape has to live somewhere neither of them owns. A key
 * name spelled slightly differently on the two sides is a wall that is silently always
 * empty and a cron that silently always succeeds.
 *
 * PURE — no Redis import, so both a server route and a test can use it.
 */

/** Redis key for a centre's ready set. `center` is a SQUARE LOCATION ID, matching
 *  `bowling_reservations.center_code`. */
export function laneReadyKey(center: string): string {
  return `bowling:laneready:v1:${center}`;
}

/**
 * How long a ready set survives without a refresh.
 *
 * Four minutes against a one-minute cadence: three consecutive misses before the wall
 * goes quiet. Generous on purpose — a guest listed as able to check in, who then vanishes
 * from the board mid-walk because one cron run was slow, is a worse outcome than a name
 * that lingers ninety seconds after they finished.
 */
export const LANE_READY_TTL_SECONDS = 240;

/**
 * One member of the set: the Neon reservation id, and the lane numbers it was assigned.
 *
 * Encoded as `"1234:12,13"` rather than JSON because a Redis SET member has to be a plain
 * string to be added, compared and expired as one unit — and because the wall only ever
 * needs these two fields. Lanes may be empty when the booked lane was marked Ready
 * without numbers being visible yet.
 */
export interface LaneReadyEntry {
  reservationId: number;
  lanes: string;
}

export function encodeLaneReady(reservationId: number, laneNumbers: number[]): string {
  return `${reservationId}:${laneNumbers.join(",")}`;
}

/**
 * Parse one set member. Returns null for anything malformed — a key written by an older
 * deploy, or a half-written value — because a wall must degrade to "nobody ready" rather
 * than throw on a screen that has run unattended for weeks.
 */
export function parseLaneReady(raw: string): LaneReadyEntry | null {
  const idx = raw.indexOf(":");
  const idPart = idx === -1 ? raw : raw.slice(0, idx);
  const id = Number(idPart);
  if (!Number.isInteger(id) || id <= 0) return null;
  const lanes = idx === -1 ? "" : raw.slice(idx + 1).trim();
  return { reservationId: id, lanes };
}

/** Every valid entry from a raw set, keyed by reservation id for a fast join against the
 *  Neon rows the feed already has. */
export function parseLaneReadySet(raw: string[]): Map<number, LaneReadyEntry> {
  const out = new Map<number, LaneReadyEntry>();
  for (const line of raw) {
    const entry = parseLaneReady(line);
    if (entry) out.set(entry.reservationId, entry);
  }
  return out;
}
