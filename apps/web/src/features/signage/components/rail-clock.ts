/**
 * M:SS for every stage rail, in one place.
 *
 * Three scenes each had their own copy of this four-line function (and the pit
 * sign a fourth for its tracker), which is a small thing until one of them
 * rounds where the others floor and two walls disagree about a countdown by a
 * second. See StageRailView for why the rest of the rail's presentation is
 * shared too.
 */
export function railClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * THE TIME OF DAY, IN VENUE TIME (owner 2026-08-24: "I'd like to have the
 * current time on each screen somewhere").
 *
 * ALWAYS America/New_York, never the player's own locale. These boxes are
 * ordinary Windows PCs that get re-imaged and moved between rooms, and a wall
 * clock reading four hours out is worse than no clock at all — a guest sets
 * their expectations by it. Same reasoning as the check-in board's own clocks.
 *
 * Takes the caller's already-synced `nowMs` rather than reading Date.now()
 * itself, so it stays pure and the screens agree to the second.
 */
export function venueTimeOfDay(nowMs: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(nowMs));
}
