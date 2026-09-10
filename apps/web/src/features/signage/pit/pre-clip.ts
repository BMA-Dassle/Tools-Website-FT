import type { TrackKey } from "../track";

/** The biggest grid the NORMAL pre-race clip covers — more than this plays
 *  `big`, the version with the extra warnings ("more than 7 people"). */
export const BIG_RACE_MAX_NORMAL = 7;

/**
 * WHICH PRE-RACE CLIP SOUNDS — the big-race warnings past seven racers. PURE.
 *
 * THE RULE (owner 2026-08-15: "we have technically 2 versions pre and big.
 * They are the same but Big race has some extra warnings. If there are more
 * than 7 people in a race we play big instead of normal pre").
 *
 * Counted off the session's FULL roster, not the checked-in count, and
 * deliberately: the extra warnings are safety copy, so the failure to prefer
 * is playing the longer clip to a group that shrank, never the short clip to
 * a big grid — and a straggler still being walked to a kart is exactly who
 * they are for. An unreadable roster plays the normal pre: the announcement
 * itself must never be held up by a Pandora blip.
 *
 * ONE RULE FOR EVERY TRACK, MEGA INCLUDED — since 2026-09-10. From 2026-08-18
 * to then Mega was exempt and always played the normal pre, because the Core's
 * mega `big` entry named `Dual Track Big Race.mp3` while the file on the
 * media drive was `Dual Big Race.mp3`. **The player took the request anyway**:
 * 19:07:38.974Z `started` on mega, 19:07:39.178Z `finished` — 204 milliseconds
 * later, no sound in the pit. Indistinguishable from a real play as far as
 * our play path can see, so the one-shot stayed spent, the stamp landed, and
 * the board told staff the pre had played. Session 58571820 (heat 21) raced
 * with no pre-race announcement and nothing on any screen said so. Mega grids
 * are almost always 8+, so that was very nearly every heat of a Mega night.
 *
 * The owner made the config and the filename agree on 2026-09-10 and asked
 * for the feature back. IF IT EVER FAILS THE SAME WAY AGAIN the tell is the
 * same: a `big` play on mega whose reported duration is well under a second
 * (the Mega big clip should run longer than the 75.6s normal pre). Put the
 * exemption back here — `if (track === "mega") return "pre"` plus the matching
 * `preClipNeedsRoster` short-circuit — until the Core is fixed again.
 */
export function preClipFor(track: TrackKey, rosterSize: number | null): "pre" | "big" {
  void track;
  return (rosterSize ?? 0) > BIG_RACE_MAX_NORMAL ? "big" : "pre";
}

/**
 * Does the clip choice depend on the grid size at all? Every track's does now
 * that Mega plays big again; the question stays so the day a track's clip is
 * fixed (as Mega's was for three weeks) the caller can skip the roster read
 * rather than spend a Pandora call whose answer cannot change the clip.
 */
export function preClipNeedsRoster(track: TrackKey): boolean {
  void track;
  return true;
}
