import "server-only";

/**
 * THE CALLED ARENA SESSIONS — one shared read, and a floor under it.
 *
 * `/bmi/sessions/current/{locationId}` is the arena's equivalent of racing's
 * `races/current`: it names the sessions being called right now. Two callers
 * ask for it — the check-in strip on every fan-out, and the arena alert cron
 * every minute — and until now BOTH called Pandora live, uncached, and returned
 * an EMPTY LIST on any failure.
 *
 * WHY THAT MATTERS MORE THAN THE CALL COUNT. Measured 2026-08-19 22:46Z,
 * sampling each endpoint five times: participants answered in ~670ms and the
 * day schedule in ~680ms, but `sessions/current` **timed out once in five**
 * (and `races/current`, its racing sibling, three times in five at a 60s
 * ceiling). An empty list on timeout is not a degraded arena row — it is NO
 * arena row. The strip silently drops every called arena session and a desk
 * sees nothing where a called heat should be.
 *
 * Racing is insulated from exactly this: the venue WebSocket writes the called
 * carry, so `races/current` failing 60% of the time went unnoticed all evening.
 * **Arena has no such wire and no backstop at all**, which makes it the most
 * exposed rail we have. This is the backstop.
 *
 * ── THE STALE RULE, WHICH IS THE WHOLE DESIGN ───────────────────────────────
 *
 * A last-known-good list is served to a DISPLAY and never to a SENDER.
 *
 * The strip is a board: a called session from thirty seconds ago beats a blank
 * panel, every time. The alert cron is irreversible — it texts guests "you're
 * checking in now" — and a stale list could tell somebody that about a session
 * that has already finished. So `allowStale` is opt-in, defaults to false, and
 * the cron does not pass it. Same principle the participants proxy already
 * follows, and the same one behind never letting the venue wire decide a
 * retraction.
 */
import redis from "@/lib/redis";
import type { ArenaCenter } from "./centers";

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net";

/** Shape from GET /v2/bmi/sessions/current/{locationID}. */
export interface CalledArenaSession {
  sessionId: string;
  resourceName: string;
  /** Parsed from the session name — "Nexus Laser Tag" / "Nexus Gel Blaster". */
  type: string;
  heatNumber: number;
  scheduledStart: string | null;
  calledAt: string;
}

/**
 * How long a fetched list is served without asking again.
 *
 * The strip polls every 15s and its own fan-out is behind a 10s cache, so 10s
 * here collapses every lambda instance onto one upstream call rather than one
 * each. Short enough that a newly-called session appears within a poll or two —
 * a called arena session lives ~20 minutes, so ten seconds is nothing against
 * it.
 */
const SERVE_TTL_SECONDS = 10;

/**
 * How long a last-known-good list may stand in AFTER a failed read.
 *
 * Generous because it is only ever reached when the upstream just failed, and
 * because a called arena session lives about twenty minutes — past that the
 * list describes sessions that have surely ended, so it lapses to empty rather
 * than lying quietly. Same shape as the roster count's ROSTER_MAX_STALE_MS.
 */
const LKG_TTL_SECONDS = 30 * 60;

const serveKey = (locationId: string) => `pandora:sessions-current:${locationId}`;
const lkgKey = (locationId: string) => `pandora:sessions-current:lkg:${locationId}`;

export interface CalledArenaResult {
  sessions: CalledArenaSession[];
  /** True when these came from the last-known-good copy after a failed read. */
  stale: boolean;
}

function parse(raw: string | null): CalledArenaSession[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as CalledArenaSession[]) : null;
  } catch {
    return null;
  }
}

/**
 * The called arena sessions for one center.
 *
 * @param allowStale serve the last-known-good copy when the live read fails.
 *   DISPLAY CALLERS ONLY — see the stale rule above. A sender must see the
 *   empty list and do nothing, rather than act on a list it cannot vouch for.
 */
export async function calledArenaSessions(
  center: ArenaCenter,
  { timeoutMs = 4000, allowStale = false }: { timeoutMs?: number; allowStale?: boolean } = {},
): Promise<CalledArenaResult> {
  const loc = center.locationId;

  // Serving cache first — this is what collapses several readers onto one call.
  try {
    const cached = parse(await redis.get(serveKey(loc)));
    if (cached) return { sessions: cached, stale: false };
  } catch {
    /* a cache we cannot read is not a reason to skip the upstream */
  }

  try {
    const res = await fetch(`${PANDORA_BASE}/v2/bmi/sessions/current/${loc}`, {
      headers: {
        Authorization: `Bearer ${process.env.SWAGGER_ADMIN_KEY || ""}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`pandora ${res.status}`);
    // No id-precision hazard here: this payload carries sessionId only, which
    // every consumer already handles as a string, and nothing writes it back.
    const json = await res.json();
    const sessions = Array.isArray(json?.data) ? (json.data as CalledArenaSession[]) : [];
    // Write both copies. The LKG is written on SUCCESS only, so it can never
    // be a record of a failure.
    redis.set(serveKey(loc), JSON.stringify(sessions), "EX", SERVE_TTL_SECONDS).catch(() => void 0);
    redis.set(lkgKey(loc), JSON.stringify(sessions), "EX", LKG_TTL_SECONDS).catch(() => void 0);
    return { sessions, stale: false };
  } catch (err) {
    console.warn(`[arena-current] live read failed for ${loc}:`, err);
    if (!allowStale) return { sessions: [], stale: false };
    const lkg = parse(await redis.get(lkgKey(loc)).catch(() => null));
    if (lkg) return { sessions: lkg, stale: true };
    return { sessions: [], stale: false };
  }
}
