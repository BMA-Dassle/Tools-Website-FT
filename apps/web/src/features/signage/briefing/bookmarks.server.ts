import "server-only";

/**
 * NX BOOKMARKS FOR EVERY BRIEFING — a marker on the NVR's own timeline at the
 * moment the film rolled, and another when the room emptied.
 *
 * WHY (owner 2026-08-14): "I'd like to create bookmarks on the cameras."
 * `briefing_events` already answers *was this group briefed, which film, how
 * long were they in the room* — but answering it to somebody's insurer means
 * somebody scrubbing an NVR timeline for a heat that happened weeks ago, armed
 * with a timestamp from a database. A bookmark puts the answer where the footage
 * is: open the room's camera, see the evening's briefings marked on the ribbon,
 * click the one you want. It also makes the clip exportable straight from the
 * bookmark (`/bookmarks/{id}/media.mp4`).
 *
 * ─── NAMING (owner: "would session as name and what is going on as
 * description work?") ────────────────────────────────────────────────────
 *
 * Yes, and it is the right way round for how Nx displays them: the NAME is what
 * renders on the timeline ribbon, where there is room for a few characters, and
 * the DESCRIPTION opens in the detail panel. So the name is the heat and nothing
 * else — and it is `sessionLabel()`, the same grammar the camera boards, the
 * check-in rail and the proceed-to-room wall already use, because the owner has
 * already had to correct two names for one heat six inches apart (see
 * checkin-progress.ts). A third spelling on the NVR would be the same mistake.
 *
 * TAGS ARE FACETS, NOT IDENTIFIERS (owner: "what would go in tags? session?").
 * Nx filters bookmarks by tag and shows the tag list as a set, so tags earn
 * their place by being things you would filter a whole evening by: `briefing`
 * finds every one of these across both cameras, `start`/`end` splits them, and
 * the room and race type narrow them. A per-session tag is deliberately NOT
 * here — it would add several hundred single-use tags a week and bury the four
 * that are useful, and the session number is already in the name where Nx's
 * text search finds it.
 *
 * BEST EFFORT, ALWAYS — same posture as room-photo.server.ts. The durable record
 * is Neon; this is a convenience pointer into the NVR. Nothing in here may fail a
 * staff action, delay a film, or block the room being freed, so every path
 * returns quietly and the worst case is a briefing with no marker on the ribbon.
 *
 * PERMISSION NOTE: creating a bookmark needs "Manage bookmarks" on the Nx user.
 * The owner login has it. camera.server.ts recommends swapping to a view-only
 * service account — do that, but grant it bookmark management too, or these stop
 * being written (silently, by design).
 */
import { sessionLabel } from "../checkin-progress";
import type { TrackKey } from "../track";
import { BRIEFING_ROOM_CAMERAS, nxConfigured, nxRelayPost } from "../nx/camera.server";
import type { BriefingRoom } from "./types";

/**
 * How much footage each marker spans.
 *
 * A bookmark is a RANGE, not a pin, and the range is what you get when you
 * export it. A minute either side of the moment is enough to show the room as
 * the film began, or the last of the group walking out — without turning the
 * ribbon into one long block that hides the individual briefings.
 */
const MARKER_MS = 60_000;

/** Start the range slightly BEFORE the event, so the clip opens on the room as
 *  it was rather than on the first frame after the thing already happened. */
const LEAD_IN_MS = 10_000;

export interface BriefingBookmarkArgs {
  room: BriefingRoom;
  track: TrackKey | string | null;
  heatNumber: number | null;
  raceType: string | null;
  /** Epoch ms of the moment being marked. */
  atMs: number;
  /** The detail panel line — what was going on. */
  description: string;
  /** `start` or `end`; becomes a filter tag. */
  phase: "start" | "end";
}

/**
 * Write one bookmark against a briefing room's camera. Never throws.
 *
 * The device comes from BRIEFING_ROOM_CAMERAS, never from a caller-supplied id,
 * for the same reason the insurance photo resolves its own: a marker must be on
 * the room it claims to be on.
 */
export async function bookmarkBriefing(args: BriefingBookmarkArgs): Promise<boolean> {
  if (!nxConfigured()) return false;
  const deviceId = BRIEFING_ROOM_CAMERAS[args.room];
  if (!deviceId || !Number.isFinite(args.atMs)) return false;

  const track = args.track === "mega" ? "mega" : undefined;
  const name = sessionLabel(args.heatNumber, args.raceType ?? "", track as TrackKey | undefined);

  const tags = ["briefing", args.phase, `${args.room} room`];
  // Race type as a filter facet, lower-cased so "Pro" and "pro" do not become
  // two tags in the list.
  if (args.raceType) tags.push(args.raceType.toLowerCase());

  try {
    const res = await nxRelayPost(`/rest/v4/devices/${encodeURIComponent(deviceId)}/bookmarks`, {
      name,
      description: args.description,
      startTimeMs: Math.floor(args.atMs - LEAD_IN_MS),
      durationMs: MARKER_MS,
      tags,
    });
    if (!res.ok) {
      console.error(`[briefing-bookmark] ${args.phase} ${name}: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[briefing-bookmark] ${args.phase} ${name} failed`, err);
    return false;
  }
}

/** "The film rolled." Called from startBriefing, first start only. */
export async function bookmarkBriefingStart(args: {
  room: BriefingRoom;
  track: TrackKey | string | null;
  heatNumber: number | null;
  raceType: string | null;
  atMs: number;
  /** Which film, so the marker says what they actually watched. */
  tier: string | null;
  videoMs: number | null;
}): Promise<boolean> {
  const mins = args.videoMs ? ` (${Math.round(args.videoMs / 1000)}s)` : "";
  const film = args.tier ? `${args.tier} film${mins}` : "no film uploaded";
  return bookmarkBriefing({
    room: args.room,
    track: args.track,
    heatNumber: args.heatNumber,
    raceType: args.raceType,
    atMs: args.atMs,
    phase: "start",
    description: `Safety briefing started in the ${args.room} room — ${film}.`,
  });
}

/**
 * "The room emptied." Called from sendToHolding, so it covers the staff press
 * AND the camera-driven sweep through one seam — a second call site is how the
 * two would drift.
 */
export async function bookmarkBriefingEnd(args: {
  room: BriefingRoom;
  track: TrackKey | string | null;
  heatNumber: number | null;
  raceType: string | null;
  atMs: number;
  /** True when the sweep decided this rather than a person. The distinction is
   *  recorded in Neon too — see events-db's `auto-holding` reason — and it
   *  belongs on the marker for exactly the same reason. */
  automatic: boolean;
}): Promise<boolean> {
  const how = args.automatic
    ? "room detected empty on camera (no motion for 30s after the briefing)"
    : "staff sent the group to holding";
  return bookmarkBriefing({
    room: args.room,
    track: args.track,
    heatNumber: args.heatNumber,
    raceType: args.raceType,
    atMs: args.atMs,
    phase: "end",
    description: `Briefing finished, ${args.room} room released — ${how}.`,
  });
}
