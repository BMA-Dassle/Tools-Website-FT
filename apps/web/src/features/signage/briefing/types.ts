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
   * DISTINCT FROM `tier`, which is only which of the two films plays — a Pro
   * session plays the Starter film, so showing `tier` on the wall would tell a Pro
   * grid they are in a Starter race. The board must show the race they are in.
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

/** What the TV is showing, derived — never stored. */
/**
 * `next` used to be a "who levelled up" board. That is PARKED (owner 2026-08-11:
 * "for qualifying just hold on that, there might be a better way… instead of
 * qualifying you could just show the inbound race to that room") — and the probe
 * agreed: qualifying cutoffs exist per-track only, so nobody can qualify off a Mega
 * lap, and Pandora's records API was 503-ing besides. The phase now shows the heat
 * heading for this room, which always has data and is what the room wants to know.
 */
export type BriefingPhase = "waiting" | "video" | "helmet" | "idle";

/**
 * The heat heading for this room next — what the third phase shows.
 *
 * No names and no ids beyond the session number: a briefing room is full of
 * strangers, and this is a "what is coming" board, not a roster.
 */
export interface BriefingInbound {
  heatNumber: number | null;
  raceType: string | null;
  /** "Mega Track", "Red Track" — where the incoming group will race. */
  trackLabel: string | null;
  /** ISO check-in cut-off for that heat, when known. */
  scheduledStart: string | null;
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

/**
 * How long a room holds an ASSIGNED session before giving up on it.
 *
 * Generous — a group can be held up at the desk, in the toilets, or buying
 * drinks, and a board that forgets them after five minutes would send staff back
 * to the control board for nothing. Long enough to be forgiving, short enough
 * that a session nobody ever started is not still on the wall an hour later.
 */
export const ASSIGNED_HOLD_MS = 45 * 60_000;
