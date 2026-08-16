/**
 * Briefing-room contracts.
 *
 * Two rooms — RED and BLUE — each with a TV. Racers are sent to a room after
 * their heat is called, watch the safety video, fit helmets, and go racing. On a
 * Mega day both rooms serve the one combined circuit and staff choose which room
 * a called session goes to.
 *
 * THE WHOLE FEATURE IS ONE SEND (owner 2026-08-11). Staff press one button per
 * session and the TV runs the entire sequence off that single trigger:
 *
 *     briefing video  →  helmet sizes (~30s)  →  who qualified last session
 *
 * Which means the room's state is not a mode staff steer through — it is a
 * START TIME plus the video's length, and every phase is derived from the shared
 * clock. A TV that reboots two minutes into a briefing rejoins two minutes into
 * the briefing; nothing is remembered, so nothing can drift. Same discipline as
 * the scene director (see director/schedule.ts).
 */

/** Which briefing room. Physical rooms, named for the track they usually serve. */
export type BriefingRoom = "red" | "blue";

export const BRIEFING_ROOMS: readonly BriefingRoom[] = ["red", "blue"] as const;

export function parseBriefingRoom(raw: unknown): BriefingRoom | null {
  return raw === "red" || raw === "blue" ? raw : null;
}

/**
 * Which briefing film to play: a racer's FIRST briefing (Starter), the shorter
 * one for returning racers (Intermediate), and the Pro briefing — which falls
 * back to Intermediate until a Pro film is uploaded (owner 2026-08-11).
 */
export type BriefingTier = "starter" | "intermediate" | "pro";

export function parseBriefingTier(raw: unknown): BriefingTier | null {
  return raw === "starter" || raw === "intermediate" || raw === "pro" ? raw : null;
}

/**
 * Session tier → which film the session ASKS for.
 *
 * PRO SESSIONS ASK FOR THE PRO FILM (owner 2026-08-11, superseding the morning's
 * "Pro plays Starter" rule from before a Pro film existed). Whether the room
 * actually gets it is resolveFilmTier's decision — a missing Pro film falls back
 * to the Intermediate one, per the owner: "fall back to intermediate when we
 * don't have it."
 *
 * Matched loosely because the upstream calls this field a lot of things
 * ("Intermediate", "Intermediate (2)", "Junior Starter"). ORDER MATTERS:
 * "intermediate" is tested before "pro" so nothing mislabels, and Junior Pro
 * deliberately lands on the Pro film — the junior distinction changes which heats
 * they may book (the race-products trap), not which safety briefing fits their
 * experience.
 */
export function tierForRaceType(raceType: string | null | undefined): BriefingTier {
  const name = (raceType || "").toLowerCase();
  if (name.includes("intermediate")) return "intermediate";
  if (name.includes("pro")) return "pro";
  // Starter, Junior Starter, and anything unrecognised.
  return "starter";
}

/**
 * The film a room will ACTUALLY play, given what has been uploaded.
 *
 * One rule, per the owner: a Pro request falls back to the Intermediate film when
 * no Pro film exists. Nothing else chains — a missing Intermediate film does not
 * reach for Starter, because showing first-timer content to an experienced grid
 * misinforms them, whereas a missing film honestly becomes the helmet board (and
 * the desk says so before the send).
 *
 * Resolved ONCE, server-side, at send/start — and the EFFECTIVE tier is what the
 * room state carries. The TV then plays `state.tier` off the manifest with no
 * fallback logic of its own, so the desk, the wall and the cache can never
 * disagree about which film a room is running.
 */
export function resolveFilmTier(
  requested: BriefingTier,
  hasFilm: (tier: BriefingTier) => boolean,
): BriefingTier {
  if (requested === "pro" && !hasFilm("pro") && hasFilm("intermediate")) return "intermediate";
  return requested;
}

/** The assets a briefing room needs. Keys are stable — they are the
 *  primary key in `signage_assets`, so renaming one orphans an upload. */
export type BriefingAssetKey =
  | "briefing-video:starter"
  | "briefing-video:intermediate"
  | "briefing-video:pro"
  | "briefing-helmet-poster"
  /** The welcome-back jingle the room TV loops while the returning group's
   *  board is up (owner 2026-08-15). Audio, not video. */
  | "welcome-back-audio";

export const BRIEFING_ASSET_KEYS: readonly BriefingAssetKey[] = [
  "briefing-video:starter",
  "briefing-video:intermediate",
  "briefing-video:pro",
  "briefing-helmet-poster",
  "welcome-back-audio",
] as const;

export function isBriefingAssetKey(raw: unknown): raw is BriefingAssetKey {
  return typeof raw === "string" && (BRIEFING_ASSET_KEYS as readonly string[]).includes(raw);
}

export function assetKeyForTier(tier: BriefingTier): BriefingAssetKey {
  if (tier === "starter") return "briefing-video:starter";
  if (tier === "pro") return "briefing-video:pro";
  return "briefing-video:intermediate";
}

/** One uploaded asset, as the TV receives it. */
export interface BriefingAsset {
  key: BriefingAssetKey;
  url: string;
  /** Bytes, for the admin page. */
  size: number | null;
  /** Video length in ms, captured in the browser BEFORE upload. THE TIMELINE
   *  DEPENDS ON THIS — see BriefingRoomState.videoDurationMs. Null for the
   *  poster. */
  durationMs: number | null;
  uploadedAt: string | null;
}

/**
 * What a briefing room is doing right now. Written to Redis by one staff press,
 * read by the TV on its 2-second pulse.
 *
 * PII POSTURE: no names, no ids beyond the session number. Nothing on this rail
 * identifies a person.
 */
export interface BriefingRoomState {
  /**
   * TWO PHASES, because the group has to walk there (owner 2026-08-11).
   *
   *  - `assigned`  sent to the room, film NOT started. The room holds on a
   *                "Session 13 — take a seat" board while they walk over and sit
   *                down. Starting the film at send time meant a group missed the
   *                opening of a safety briefing.
   *  - `timeline`  staff pressed Start: video → helmet sizes, derived from
   *                `triggeredAtMs`. After that the room is free.
   */
  kind: "assigned" | "timeline";
  /** Which video the timeline plays. */
  tier: BriefingTier | null;
  /** Track the session belongs to — shown on the pre-video board. */
  track: "blue" | "red" | "mega";
  /**
   * The session's own level as the timing system words it ("Starter",
   * "Intermediate", "Pro").
   *
   * DISTINCT FROM `tier`, which is only which FILM plays — a Pro session with no
   * Pro film uploaded plays the Intermediate one, and showing `tier` on the wall
   * would then tell a Pro grid they are in an Intermediate race. The board must
   * show the race they are in.
   */
  raceType: string | null;
  /** Pandora session id, as a STRING. Never a number: BMI/Pandora ids can
   *  exceed Number.MAX_SAFE_INTEGER and this one is round-tripped through JSON
   *  and Postgres (house rule — see CLAUDE.md). */
  sessionId: string;
  heatNumber: number | null;
  /**
   * Shared-clock ms the timeline STARTED — i.e. when staff pressed Start, not
   * when they sent the group. THE ONLY CLOCK the timeline has.
   *
   * While `kind` is `assigned` this is the send time and nothing reads it as a
   * video offset; it exists so the holding board can say how long they have been
   * waiting, and so the state has one consistent stamp.
   */
  triggeredAtMs: number;
  /** Resolved from the asset manifest at send time, so a mid-briefing re-upload
   *  cannot swap the film out from under a room. */
  videoUrl: string | null;
  /** Video length in ms. Null ⇒ the phase calculator falls back to a nominal
   *  length rather than getting stuck on the video forever. */
  videoDurationMs: number | null;
}

/**
 * What the TV is showing, derived — never stored.
 *
 * A briefing is video → helmet sizes, and then the room is FREE. There is no third
 * phase, and the wall says NOTHING about a race until that race has been sent here:
 * a "who levelled up" board is parked (cutoffs are per-track, so nobody can qualify
 * off a Mega lap), and a "next up" board announced one session in BOTH rooms on a
 * Mega day when it could only go to one of them (owner 2026-08-11). Idle is helmet
 * sizes — content the next group wants anyway.
 */
export type BriefingPhase = "waiting" | "video" | "helmet" | "idle";

/** How long the helmet-sizing board holds after the video (owner: "about 30
 *  seconds"). Long enough to find your size, short enough that a group is not
 *  standing in front of a static poster. */
export const HELMET_PHASE_MS = 30_000;

/**
 * When a video's length is unknown, assume this long.
 *
 * Only reachable if a manifest row predates duration capture. Deliberately a
 * real briefing's length rather than something tiny: overrunning shows the
 * helmet board a little late, whereas underrunning would cut the safety video
 * off mid-sentence.
 */
export const NOMINAL_VIDEO_MS = 5 * 60_000;

/**
 * How long a room holds an ASSIGNED session before giving up on it.
 *
 * Generous — a group can be held up at the desk, in the toilets, or buying
 * drinks, and a board that forgets them after five minutes would send staff back
 * to the control board for nothing. Long enough to be forgiving, short enough
 * that a session nobody ever started is not still on the wall an hour later.
 */
export const ASSIGNED_HOLD_MS = 45 * 60_000;
