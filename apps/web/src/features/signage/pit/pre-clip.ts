import type { TrackKey } from "../track";

/** The biggest grid the NORMAL pre-race clip covers — more than this plays
 *  `big`, the version with the extra warnings ("more than 7 people"). */
export const BIG_RACE_MAX_NORMAL = 7;

/**
 * WHICH PRE-RACE CLIP SOUNDS — the big-race warnings, unless this is Mega. PURE.
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
 * MEGA IS EXEMPT — IT ALWAYS PLAYS THE NORMAL PRE (owner 2026-08-18, called
 * mid-Mega: "just use dual track pre-message for all races on mega").
 *
 * The Core's Mega `big` entry is configured for `Dual Track Big Race.mp3`;
 * the file actually sitting on the Core's media drive is `Dual Big Race.mp3`.
 * The two names never matched, so every Mega big-race press asked the player
 * for a file that does not exist. **The player took the request anyway**:
 * 2026-08-18 19:07:38.974Z `started` on mega, 19:07:39.178Z `finished` — 204
 * milliseconds later, no sound in the pit. That is indistinguishable from a
 * clip that really played as far as our play path can see, so the one-shot
 * claim stayed spent, the stamp landed, and the board told staff the pre had
 * played. Session 58571820 (heat 21) raced with no pre-race announcement and
 * nothing on any screen said so.
 *
 * Mega grids are almost always 8+, so this was very nearly every heat of a
 * Mega night — which is why it surfaced on one and not on the red/blue nights
 * either side of it. Red and blue keep the rule unchanged: their own `big`
 * entries resolve to files that exist and play (blue's measured at 133.8s on
 * 2026-08-16).
 *
 * Restoring Mega's big race is a Core-side fix, not a code one — make the
 * clip config and the filename agree, then delete the `mega` branch here.
 * The normal Mega pre is verified good: `Dual Track Pre-Message.mp3`, 75.6s,
 * measured off the player the same night.
 */
export function preClipFor(track: TrackKey, rosterSize: number | null): "pre" | "big" {
  if (track === "mega") return "pre";
  return (rosterSize ?? 0) > BIG_RACE_MAX_NORMAL ? "big" : "pre";
}

/**
 * Does the clip choice depend on the grid size at all? Mega never asks, so
 * the caller can skip the roster read rather than spend a Pandora call whose
 * answer cannot change the clip. Lives here so the exemption is stated once:
 * when Mega's big race comes back, both halves flip in this one file.
 */
export function preClipNeedsRoster(track: TrackKey): boolean {
  return track !== "mega";
}
