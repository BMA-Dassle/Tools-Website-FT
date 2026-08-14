/**
 * Pairing groups: which screens are two halves of ONE thing.
 *
 * A pairing already drives composed content — the birthday takeover splits one
 * message across both boards, and Mega day splits the track rail — via
 * `pairing.position` / `pairing.count`. This module is the other half of that
 * idea: given a screen, WHICH screens share its group, in position order.
 *
 * Used by the admin page (to offer a two-monitor launcher only where one can
 * work) and by the download route (to build it). One implementation so the
 * button and the file can never disagree about which board is on the left.
 *
 * PURE — no I/O. Position order is the contract: 0 is the LEFT monitor.
 */

/** The minimum a screen has to look like to be grouped. */
export interface PairableScreen {
  screenId: string;
  name: string;
  config: { pairing?: { groupId: string; position: number; count: number } | null };
}

export interface ResolvedPair<T extends PairableScreen> {
  groupId: string;
  /** position 0 — the LEFT monitor. */
  left: T;
  /** The next position — the RIGHT monitor. */
  right: T;
}

/**
 * The two screens of `screenId`'s pairing group, ordered by position.
 *
 * Returns null unless the group resolves to EXACTLY two screens: a group of one
 * is a half-finished setup, and a group of three is not something a
 * two-monitor player can express. Callers should treat null as "don't offer
 * it", never as an error to surface on a wall.
 *
 * Ties on position sort by screenId so the answer is stable — two screens both
 * left at position 0 would otherwise swap sides depending on row order, which
 * is exactly the kind of intermittent wrongness nobody can reproduce.
 */
export function resolvePair<T extends PairableScreen>(
  screens: readonly T[],
  screenId: string,
): ResolvedPair<T> | null {
  const anchor = screens.find((s) => s.screenId === screenId);
  const groupId = anchor?.config.pairing?.groupId;
  if (!groupId) return null;

  const members = screens
    .filter((s) => s.config.pairing?.groupId === groupId)
    .sort((a, b) => {
      const byPosition = (a.config.pairing?.position ?? 0) - (b.config.pairing?.position ?? 0);
      return byPosition !== 0 ? byPosition : a.screenId.localeCompare(b.screenId);
    });

  if (members.length !== 2) return null;
  return { groupId, left: members[0], right: members[1] };
}

/** Why a pair could not be resolved, for staff-facing copy on the admin page. */
export function pairProblem(screens: readonly PairableScreen[], screenId: string): string | null {
  const anchor = screens.find((s) => s.screenId === screenId);
  if (!anchor) return "unknown screen";
  const groupId = anchor.config.pairing?.groupId;
  if (!groupId) return "this screen is not in a pairing group yet";
  const count = screens.filter((s) => s.config.pairing?.groupId === groupId).length;
  if (count !== 2) {
    return `pairing group "${groupId}" has ${count} screen${count === 1 ? "" : "s"}; a two-monitor launcher needs exactly 2`;
  }
  return null;
}
