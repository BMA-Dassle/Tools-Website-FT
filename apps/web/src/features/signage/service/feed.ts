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
import type { TvFeed } from "../types";

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

  const [raceCheckin, events, nextAvailable] = await Promise.all([
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
  ]);

  return {
    ...base,
    screen,
    kioskEvents,
    reloadAt,
    demoMode,
    raceCheckin,
    events,
    nextAvailable,
    // `vip` (the bowling-leg takeover) lands with the next scene.
    vip: null,
    // Null events mean we could not ask — the welcome entry then self-skips
    // and the rotation closes over it rather than showing an empty board.
    degraded: wantsWelcome && events === null,
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
 * Three Redis reads and nothing else — no Neon, no BMI. That is what lets the
 * screens poll it every couple of seconds so a scan lands on the wall while the
 * racer is still standing at the desk, without putting the party board's
 * database work on the same cadence.
 */
export async function buildTvPulse(
  screenIdRaw: string | null,
  buildSha?: string | null,
): Promise<{
  now: number;
  kioskEvents: TvFeed["kioskEvents"];
  reloadAt: number | null;
  demoMode: string | null;
}> {
  const now = Date.now();
  const parsed = parseScreenKey(screenIdRaw);
  if (!parsed || !screenIdRaw) return { now, kioskEvents: [], reloadAt: null, demoMode: null };

  const center = VENUE_INFO[parsed.venue]?.center ?? "fort-myers";
  // The pulse is the frequent one, so the build stamp rides it.
  void stampSeen(screenIdRaw, buildSha);
  const [kioskEvents, reloadAt, demoMode] = await Promise.all([
    readSignageEvents(center).catch(() => []),
    reloadRequestedAt(center).catch(() => null),
    demoRequestedFor(screenIdRaw).catch(() => null),
  ]);
  return { now, kioskEvents, reloadAt, demoMode };
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
