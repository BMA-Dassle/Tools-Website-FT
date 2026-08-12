import "server-only";

/**
 * Composes everything a TV needs into ONE payload.
 *
 * ONE endpoint, one poll, one place to cache and to fail open. Splitting this
 * per-scene would multiply the request count by the number of screens times the
 * number of scenes, for data that all comes from the same three sources.
 *
 * FAIL OPEN, ALWAYS. Every section is independently optional and every upstream
 * is wrapped. A TV must never render an error: the worst case is that sections
 * come back null, their playlist entries self-skip, and the screen falls back to
 * house ads — which need no server data at all. There is no code path here that
 * can put a stack trace on a lobby wall.
 *
 * PII posture: first names only, and no ids of any kind in the response. See
 * the note on SignageEvent.
 */
import redis from "@/lib/redis";
import { pausedProductIds } from "~/features/maintenance";
import { businessDayYmdET } from "@/lib/race-business-day";
import { fmtTime12, toEtWallClock } from "~/features/kiosk/checkin/itinerary";
import { loadSignageScreen } from "../data/signage-screens-db";
import { parseScreenKey, VENUE_INFO, type SignageVenue } from "../constants";
import {
  signageEventsKey,
  readSignageEvents,
  reloadRequestedAt,
  demoRequestedFor,
} from "../events.server";
import { resolveScreenConfig } from "../defaults";
import { trackFromResourceIds } from "../track";
import { raceCheckinInfo } from "./race-checkin";
import { buildWelcomeBoard } from "./welcome";
import { briefingEnabled } from "../flags";
import { loadSignageAssetsSafe } from "../data/signage-assets-db";
import { readBriefingRooms, sessionBriefed } from "../briefing/state.server";
import { resolveWelcomeBack } from "../briefing/welcome-back.server";
import type { TvFeed, TvPulse } from "../types";

/** Screens phone home on every poll; the admin page reads these for its
 *  online dots. Never a Neon write per poll — a wall of TVs at 10s each would
 *  be a pointless write storm. */
const SEEN_TTL_SECONDS = 900;

async function stampSeen(screenId: string, buildSha?: string | null): Promise<void> {
  try {
    // Record WHICH BUILD the screen is running, not just that it is alive.
    //
    // Every confusing hour tonight came down to "is that board on current
    // code?", and there was no way to answer it without walking to the player.
    // A heartbeat that says "alive" and nothing else is what let a stale board
    // look like a broken feature more than once.
    const payload = JSON.stringify({ at: new Date().toISOString(), build: buildSha ?? null });
    await redis.set(`signage:seen:${screenId}`, payload, "EX", SEEN_TTL_SECONDS);
  } catch {
    /* a heartbeat is diagnostics, never a reason to fail a feed */
  }
}

/**
 * Build the feed for one screen.
 *
 * An UNPROVISIONED screen id is not an error — it gets the ads-only shape with
 * `screen: null`, so a mistyped URL on a wall shows house advertising rather
 * than a setup prompt in front of guests. It also gets no guest data at all,
 * which is the security property: names only reach screens someone deliberately
 * registered.
 */
export async function buildTvFeed(
  screenIdRaw: string | null,
  buildSha?: string | null,
): Promise<TvFeed> {
  const now = Date.now();
  const parsed = parseScreenKey(screenIdRaw);

  const base: TvFeed = {
    now,
    screen: null,
    events: null,
    vip: null,
    kioskEvents: [],
    raceCheckin: null,
    briefing: null,
    briefingRooms: null,
    pausedProductIds: safePaused(),
    nextAvailable: null,
    reloadAt: null,
    demoMode: null,
    degraded: false,
  };

  if (!parsed || !screenIdRaw) return base;

  const screen = await loadSignageScreen(screenIdRaw).catch(() => null);
  if (!screen) return base;

  void stampSeen(screen.screenId, buildSha);

  const center = VENUE_INFO[parsed.venue]?.center ?? screen.center;

  // Read fresh on every poll, deliberately OUTSIDE any cache: a celebration is
  // about someone standing at a kiosk right now, and it must not wait out a
  // cache TTL. One LRANGE is cheap enough to do per screen per poll.
  const kioskEvents = await readSignageEvents(center).catch(() => []);
  const reloadAt = await reloadRequestedAt(center).catch(() => null);
  const demoMode = await demoRequestedFor(screen.screenId).catch(() => null);

  // Track screens only: who is on the heat checking in right now. Everything
  // else the scene needs it fetches itself from the endpoints the website uses.
  const config = resolveScreenConfig(screen.config, parsed.venue);
  const ymd = businessDayYmdET();
  const track = trackFromResourceIds(config.scope.resourceIds);

  // Only build what this screen actually shows. A track screen has no use for
  // the party board, and a lobby TV has no track — computing both for every
  // screen would double the work for nothing.
  const wantsWelcome = config.playlist.some((p) => p.scene === "event-welcome");
  const wantsBriefing =
    briefingEnabled() &&
    config.briefingRoom !== null &&
    config.playlist.some((p) => p.scene === "briefing");

  const [raceCheckin, events, nextAvailable, briefing] = await Promise.all([
    track ? raceCheckinInfo(track, ymd).catch(() => null) : Promise.resolve(null),
    wantsWelcome
      ? buildWelcomeBoard(
          parsed.venue,
          config.scope.gfCenterCodes,
          ymd,
          { leadMins: config.welcomeLeadMins, trailMins: config.welcomeTrailMins },
          now,
        ).catch(() => null)
      : Promise.resolve(null),
    config.showNextAvailable
      ? buildNextAvailable(parsed.venue).catch(() => null)
      : Promise.resolve(null),
    wantsBriefing
      ? buildBriefingSection(parsed.venue, config.briefingRoom as "red" | "blue", ymd).catch(
          () => null,
        )
      : Promise.resolve(null),
  ]);

  // Has the heat on the track board already been sent to a briefing room? One
  // Redis GET, and only for screens that actually show a track board.
  const briefed = raceCheckin
    ? await sessionBriefed(
        raceCheckin.sessionId != null ? String(raceCheckin.sessionId) : null,
      ).catch(() => null)
    : null;
  const raceCheckinWithBriefing = raceCheckin
    ? { ...raceCheckin, briefedAtMs: briefed?.atMs ?? null, briefedRoom: briefed?.room ?? null }
    : null;

  return {
    ...base,
    screen,
    kioskEvents,
    reloadAt,
    demoMode,
    raceCheckin: raceCheckinWithBriefing,
    events,
    nextAvailable,
    briefing: briefing?.section ?? null,
    briefingRooms: briefing?.rooms ?? null,
    // `vip` (the bowling-leg takeover) lands with the next scene.
    vip: null,
    // Null events mean we could not ask — the welcome entry then self-skips
    // and the rotation closes over it rather than showing an empty board.
    degraded: wantsWelcome && events === null,
  };
}

/**
 * What a briefing room's TV needs from the slow feed: the films, the poster, and
 * the qualification board for the group that is out racing.
 *
 * The manifest is read on every full poll rather than cached, because the read is
 * one small Neon SELECT and the alternative — a cache between an upload and the
 * wall — is the exact reason a staff member would stand in a briefing room
 * wondering why the video they just uploaded is not playing.
 *
 */
async function buildBriefingSection(
  venue: SignageVenue,
  room: "red" | "blue",
  businessDay: string,
): Promise<{
  section: NonNullable<TvFeed["briefing"]>;
  rooms: TvFeed["briefingRooms"];
}> {
  const [assets, rooms, welcomeBack] = await Promise.all([
    loadSignageAssetsSafe(),
    readBriefingRooms(venue).catch(() => ({ red: null, blue: null })),
    // The group's return — from the timing system's own actualEnd, read LIVE on
    // every poll (owner: end shows within 15s). Null while they are still out.
    resolveWelcomeBack(venue, room, businessDay).catch(() => null),
  ]);

  const starter = assets["briefing-video:starter"];
  const intermediate = assets["briefing-video:intermediate"];
  const pro = assets["briefing-video:pro"];
  const poster = assets["briefing-helmet-poster"];

  return {
    section: {
      videos: {
        starter: starter ? { url: starter.url, durationMs: starter.durationMs } : null,
        intermediate: intermediate
          ? { url: intermediate.url, durationMs: intermediate.durationMs }
          : null,
        pro: pro ? { url: pro.url, durationMs: pro.durationMs } : null,
      },
      helmetPosterUrl: poster?.url ?? null,
      welcomeBack: welcomeBack
        ? {
            heatNumber: welcomeBack.heatNumber,
            raceType: welcomeBack.raceType,
            track: welcomeBack.track,
            results: welcomeBack.results,
          }
        : null,
    },
    rooms,
  };
}

function safePaused(): string[] {
  try {
    return pausedProductIds();
  } catch {
    // An unreadable maintenance config must not stop the screen; the cost of
    // guessing wrong here is one advert for a paused product, not an outage.
    return [];
  }
}

/**
 * The LIVE half of the feed: only the things that change second to second.
 *
 * Redis reads and nothing else — no Neon, no BMI. That is what lets the screens
 * poll it every couple of seconds so a scan lands on the wall while the racer is
 * still standing at the desk, and a briefing reaches a room's TV about two
 * seconds after staff press send, without putting the party board's database work
 * on the same cadence.
 *
 * DELIBERATELY DOES NOT LOAD THE SCREEN ROW. The briefing state is fetched
 * per-VENUE (one MGET for both rooms) and each TV picks its own room out of it
 * client-side, precisely so this stays a fixed handful of Redis reads no matter
 * how many screens are hanging.
 */
export async function buildTvPulse(
  screenIdRaw: string | null,
  buildSha?: string | null,
): Promise<TvPulse> {
  const now = Date.now();
  const parsed = parseScreenKey(screenIdRaw);
  if (!parsed || !screenIdRaw) {
    return { now, kioskEvents: [], reloadAt: null, demoMode: null, briefingRooms: null };
  }

  const center = VENUE_INFO[parsed.venue]?.center ?? "fort-myers";
  // The pulse is the frequent one, so the build stamp rides it.
  void stampSeen(screenIdRaw, buildSha);
  // Briefing rooms exist at FastTrax only. Asking for them at HeadPinz would be
  // two wasted Redis reads on every pulse of every lobby screen.
  const wantsBriefing = briefingEnabled() && parsed.venue === "FT";
  const [kioskEvents, reloadAt, demoMode, briefingRooms] = await Promise.all([
    readSignageEvents(center).catch(() => []),
    reloadRequestedAt(center).catch(() => null),
    demoRequestedFor(screenIdRaw).catch(() => null),
    wantsBriefing ? readBriefingRooms(parsed.venue).catch(() => null) : Promise.resolve(null),
  ]);
  return { now, kioskEvents, reloadAt, demoMode, briefingRooms };
}

/**
 * "Next available" per product, for the ad slides.
 *
 * Reads the SAME Redis entry the kiosks read (`kiosk:avail:v4:{center}`, the
 * three-minute cache behind /api/kiosk/availability) rather than recomputing.
 * Two reasons, and both matter: the compute fans out across BMI and QAMF and
 * has a 60-second ceiling, which has no business on a screen's poll; and
 * sharing the cache is what guarantees a wall quoting a time and the machine
 * below it selling that time cannot disagree.
 *
 * Never computes on a miss. No cache means no times on the slides — an advert
 * promising a slot the kiosk will then refuse is worse than one with no time
 * on it at all.
 */
async function buildNextAvailable(venue: SignageVenue): Promise<Record<string, string> | null> {
  try {
    const center = VENUE_INFO[venue].center;
    const raw = await redis.get(`kiosk:avail:v4:${center}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      available?: Record<string, boolean>;
      firstOpen?: Record<string, { start?: string; freeSpots?: number }>;
    };
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(parsed.firstOpen ?? {})) {
      if (!entry?.start) continue;
      // A locked tile never gets a time — see the note above.
      if (parsed.available?.[key] === false) continue;
      // TIME RULE (lesson 51a47370). These starts are NAIVE ET wall-clock
      // ("2026-08-11T11:00:00", no zone). `new Date(...)` parses that as the
      // SERVER's zone — UTC on Vercel — and converting the result to ET then
      // shifts it back four hours, which is how an 11:00 AM opening rendered as
      // "Next available 7:00 AM" on the wall. toEtWallClock + fmtTime12 render
      // the wall-clock components as written, and also handle the Z-stamped
      // case correctly, so this is right for either shape.
      const time = fmtTime12(toEtWallClock(entry.start));
      if (!time) continue;
      out[key] = entry.freeSpots ? `${entry.freeSpots} left · ${time}` : time;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

export { signageEventsKey };
