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
import { loadSignageScreen } from "../data/signage-screens-db";
import { parseScreenKey, VENUE_INFO } from "../constants";
import { signageEventsKey, readSignageEvents } from "../events.server";
import type { TvFeed } from "../types";

/** Screens phone home on every poll; the admin page reads these for its
 *  online dots. Never a Neon write per poll — a wall of TVs at 10s each would
 *  be a pointless write storm. */
const SEEN_TTL_SECONDS = 900;

async function stampSeen(screenId: string): Promise<void> {
  try {
    await redis.set(`signage:seen:${screenId}`, new Date().toISOString(), "EX", SEEN_TTL_SECONDS);
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
export async function buildTvFeed(screenIdRaw: string | null): Promise<TvFeed> {
  const now = Date.now();
  const parsed = parseScreenKey(screenIdRaw);

  const base: TvFeed = {
    now,
    screen: null,
    events: null,
    vip: null,
    kioskEvents: [],
    pausedProductIds: safePaused(),
    degraded: false,
  };

  if (!parsed || !screenIdRaw) return base;

  const screen = await loadSignageScreen(screenIdRaw).catch(() => null);
  if (!screen) return base;

  void stampSeen(screen.screenId);

  const center = VENUE_INFO[parsed.venue]?.center ?? screen.center;

  // Read fresh on every poll, deliberately OUTSIDE any cache: a celebration is
  // about someone standing at a kiosk right now, and it must not wait out a
  // cache TTL. One LRANGE is cheap enough to do per screen per poll.
  const kioskEvents = await readSignageEvents(center).catch(() => []);

  return {
    ...base,
    screen,
    kioskEvents,
    // events / vip land with the welcome-board PR. Null (not []) on purpose:
    // "we have nothing to say" and "we could not ask" are different, and only
    // the former should let a playlist entry claim it has data.
    events: null,
    vip: null,
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

export { signageEventsKey };
