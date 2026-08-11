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
 * Which briefing video to play. Only two exist: a racer's FIRST briefing
 * (Starter) and the shorter one for anyone who has raced before (Intermediate).
 */
export type BriefingTier = "starter" | "intermediate";

export function parseBriefingTier(raw: unknown): BriefingTier | null {
  return raw === "starter" || raw === "intermediate" ? raw : null;
}

/**
 * Session tier → which video plays.
 *
 * PRO SESSIONS GET THE STARTER VIDEO (owner 2026-08-11). There is no Pro
 * briefing film, and the owner's call was the full safety briefing rather than
 * the short one — a Pro grid still contains people who have not been in a kart
 * this season. Staff can override per send.
 *
 * Matched loosely because the upstream calls this field a lot of things
 * ("Intermediate", "Intermediate (2)", "Junior Starter").
 */
export function tierForRaceType(raceType: string | null | undefined): BriefingTier {
  const name = (raceType || "").toLowerCase();
  if (name.includes("intermediate")) return "intermediate";
  // Starter, Junior Starter, Pro, Junior Pro, and anything unrecognised.
  return "starter";
}

/** The three assets a briefing room needs. Keys are stable — they are the
 *  primary key in `signage_assets`, so renaming one orphans an upload. */
export type BriefingAssetKey =
  | "briefing-video:starter"
  | "briefing-video:intermediate"
  | "briefing-helmet-poster";

export const BRIEFING_ASSET_KEYS: readonly BriefingAssetKey[] = [
  "briefing-video:starter",
  "briefing-video:intermediate",
  "briefing-helmet-poster",
] as const;

export function isBriefingAssetKey(raw: unknown): raw is BriefingAssetKey {
  return typeof raw === "string" && (BRIEFING_ASSET_KEYS as readonly string[]).includes(raw);
}

export function assetKeyForTier(tier: BriefingTier): BriefingAssetKey {
  return tier === "starter" ? "briefing-video:starter" : "briefing-video:intermediate";
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
 * PII POSTURE: no names, no ids beyond the session number. The qualifier names
 * that eventually appear on the wall are resolved server-side on the FULL feed
 * (see quals.server.ts) and are first-name only, matching the event rail.
 */
export interface BriefingRoomState {
  /**
   *  - `timeline`   the ordinary send: video → helmet → quals.
   *  - `quals-only` staff jumped straight to the qualification board (a group
   *                 came back without a next briefing queued).
   */
  kind: "timeline" | "quals-only";
  /** Which video the timeline plays. Null for `quals-only`. */
  tier: BriefingTier | null;
  /** Track the session belongs to — drives the room's accent colour. */
  track: "blue" | "red" | "mega";
  /** Pandora session id, as a STRING. Never a number: BMI/Pandora ids can
   *  exceed Number.MAX_SAFE_INTEGER and this one is round-tripped through JSON
   *  and Postgres (house rule — see CLAUDE.md). */
  sessionId: string;
  heatNumber: number | null;
  /** Shared-clock ms the send happened. THE ONLY CLOCK the timeline has. */
  triggeredAtMs: number;
  /** Resolved from the asset manifest at send time, so a mid-briefing re-upload
   *  cannot swap the film out from under a room. */
  videoUrl: string | null;
  /** Video length in ms. Null ⇒ the phase calculator falls back to a nominal
   *  length rather than getting stuck on the video forever. */
  videoDurationMs: number | null;
}

/** What the TV is showing, derived — never stored. */
export type BriefingPhase = "video" | "helmet" | "quals" | "idle";

/**
 * One racer who levelled up in the session that just finished.
 *
 * FIRST NAME ONLY. This goes on a wall in a room full of strangers, and it
 * follows the same posture as the event rail (see SignageEvent): no surname, no
 * ids, nothing that identifies a person beyond the greeting.
 */
export interface BriefingQualifier {
  /** First name, already reduced server-side. */
  firstName: string;
  level: QualifyLevelName;
  /** Their best lap, pre-formatted ("36.785"). The proof, and the brag. */
  bestLap: string;
}

/** Mirrors QualifyLevel in ~/features/racing/qualify — the levels a racer can
 *  qualify INTO. Restated here so this contract file needs no import. */
export type QualifyLevelName = "Intermediate" | "Pro";

/** What the briefing boards show alongside the room state. */
export interface BriefingQualsBoard {
  /** The session these qualifiers came from. */
  heatNumber: number | null;
  raceType: string | null;
  qualifiers: BriefingQualifier[];
}

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

/** How long the qualification board holds before the room falls idle. Covers a
 *  normal between-heats gap without leaving last hour's names on a wall. */
export const QUALS_PHASE_MS = 30 * 60_000;
