import "server-only";

/**
 * WHICH ARENA SESSIONS HAVE JUST BEEN CALLED, per venue.
 *
 * Source is Pandora's `GET /v2/bmi/sessions/current/{locationId}` — the same
 * endpoint the arena SMS cron has run on since 2026-06-11
 * (arena-tickets/checkin-alerts.ts), populated from Firebird's
 * SessionAboutToStart notifications and expiring entries about twenty minutes
 * after the call.
 *
 * CLASSIFIED FOR A WALL. Laser Tag and Gel Blaster share the ONE "HP Arena"
 * dayplanner resource, and the activity is only ever recoverable from the session
 * name ("25 - Nexus Laser Tag"). `classifyArenaBoardSession` is a deliberate
 * superset of the cron's own classifier: it agrees with it on the 96% of sessions
 * that plainly name one game, and differs only where a wall cannot afford the
 * cron's shortcuts — a birthday booked as "Gel Blaster or Laser Tag" resolves to
 * `either` instead of guessing, and "Nexus LaserTag" (no space) is recognised
 * rather than dropped. See the note on that function. A session naming neither
 * game is skipped, as it is in the cron.
 *
 * NAPLES IS THE SAME SHAPE. Verified by a 10-day live sweep (2026-09-01): HP
 * Naples publishes to the identical `HP Arena` resource with identical session
 * naming, both activities, on a lighter day. Nothing here is Fort Myers-specific
 * — the venue's Pandora location id is the only input that changes. (Note this
 * is a READ. The arena TICKET system is still FM-only because its dedup keys are
 * not location-scoped; that constraint does not reach a board that only looks.)
 *
 * FAILS OPEN, ALWAYS. Every path returns an array. A screen must never render an
 * error, and the worst outcome available here is "no call on the wall", which is
 * the board's ordinary state for most of the day anyway.
 */
import redis from "@/lib/redis";
import { VENUE_INFO, type SignageVenue } from "../constants";
import { ARENA_HOLD_MAX_MS, classifyArenaBoardSession, type ArenaCall } from "./arena-board";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";

/**
 * Upstream timeout. Short on purpose: this read sits inside the 15-second TV
 * feed, and a wall waiting on a slow vendor is a wall not repainting. A miss
 * falls through to the carry below, which is the whole reason the carry exists.
 */
const UPSTREAM_TIMEOUT_MS = 6_000;

/**
 * Shared per-venue build cache.
 *
 * TWO ARENA BOARDS ON ONE VENUE MUST COST ONE READ, and — more importantly —
 * must never show two different answers. Same pattern resolveResultsBoard uses
 * for the scores walls. Eight seconds is comfortably under the 15s feed poll, so
 * a board still sees a call within one poll of it landing, while a second screen
 * polling a beat later is served the identical object.
 */
const CACHE_TTL_MS = 8_000;
const cache = new Map<SignageVenue, { at: number; calls: ArenaCall[] }>();

/**
 * THE CARRY, and it is location-scoped — read the key name twice before
 * changing it.
 *
 * `pandora:last-race:fasttrax:{track}` gets away with a bare track because
 * FastTrax is the only venue with tracks. There are TWO arenas on two separate
 * BMI servers whose session ids share a numbering space, so an unscoped key here
 * would put a Naples call on a Fort Myers wall. The location id is in the key
 * for that reason and no other.
 *
 * TTL is the maximum a call could ever be worth displaying (see
 * ARENA_HOLD_MAX_MS) plus a minute of slack: past that the entry is not stale
 * data, it is data no reader would accept, so it should not be occupying Redis.
 */
const carryKey = (locationId: string) => `signage:arena-called:${locationId}`;
const CARRY_TTL_SECONDS = Math.ceil((ARENA_HOLD_MAX_MS + 60_000) / 1000);

/** Shape of one row from `sessions/current`. Everything optional — this is a
 *  vendor payload, and a missing field must narrow the board, never throw. */
interface PandoraCurrentSession {
  sessionId?: string | number;
  resourceName?: string;
  /** "Nexus Laser Tag" / "Nexus Gel Blaster" — what the activity is read from. */
  type?: string;
  name?: string;
  heatNumber?: number;
  scheduledStart?: string | null;
  calledAt?: string;
}

/**
 * One vendor row → one board fact, or null when it is not an arena session we
 * can stand behind.
 *
 * BOTH FIELDS ARE JOINED before classifying, not tried in turn. They carry the
 * same words in different wrappings ("Nexus Laser Tag" vs "25 - Nexus Laser
 * Tag"), so one being blank must not lose the session — and a birthday whose
 * `type` is `"- Gel Blaster or Laser Tag"` has to be seen WHOLE for the
 * both-games case to be recognised at all. Neither field naming a game means a
 * private hire or an event booked onto the arena resource, which is not this
 * board's business.
 */
function toCall(row: PandoraCurrentSession): ArenaCall | null {
  // personId/sessionId precision: BMI ids can exceed Number.MAX_SAFE_INTEGER,
  // so this stays a string end to end and is never passed through Number().
  const sessionId = row.sessionId == null ? "" : String(row.sessionId);
  if (!sessionId) return null;

  const activity = classifyArenaBoardSession(`${row.type || ""} ${row.name || ""}`);
  if (!activity) return null;

  const calledAtMs = row.calledAt ? Date.parse(row.calledAt) : NaN;
  // NO CALL TIME, NO CALL. Every rule this board has — the hold, the countdown,
  // the frame key — is measured from this instant, and inventing one (now, say)
  // would restart a stale session's ten-minute window on every single poll.
  if (!Number.isFinite(calledAtMs)) return null;

  return {
    sessionId,
    activity,
    heatNumber: typeof row.heatNumber === "number" ? row.heatNumber : null,
    scheduledStart: row.scheduledStart ?? null,
    calledAtMs,
  };
}

async function fetchCalled(locationId: string): Promise<ArenaCall[] | null> {
  try {
    const res = await fetch(`${PANDORA_URL}/bmi/sessions/current/${locationId}`, {
      headers: {
        Authorization: `Bearer ${process.env.SWAGGER_ADMIN_KEY || ""}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    // Parsed with the ordinary parser ON PURPOSE: nothing read out of this body
    // is an id we do arithmetic on — `sessionId` is stringified above and never
    // compared numerically — and no value from here is ever written back to BMI.
    const json = (await res.json()) as { data?: unknown };
    if (!Array.isArray(json?.data)) return null;
    return (json.data as PandoraCurrentSession[])
      .map(toCall)
      .filter((c): c is ArenaCall => c !== null);
  } catch {
    // A timeout is the expected failure here, not an exceptional one. Null means
    // "could not ask", which the caller turns into the carry — distinct from
    // `[]`, which means "asked, nothing is called".
    return null;
  }
}

async function readCarry(locationId: string): Promise<ArenaCall[]> {
  try {
    const raw = await redis.get(carryKey(locationId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ArenaCall[]) : [];
  } catch {
    return [];
  }
}

async function writeCarry(locationId: string, calls: ArenaCall[]): Promise<void> {
  try {
    await redis.set(carryKey(locationId), JSON.stringify(calls), "EX", CARRY_TTL_SECONDS);
  } catch {
    /* the carry is a cushion, never a reason to fail a feed */
  }
}

/**
 * Every arena session currently called at this venue.
 *
 * A LIVE READ IS AUTHORITATIVE EVEN WHEN IT IS EMPTY. Pandora answering "nothing
 * is called" is a fact, and the carry is overwritten with it — the alternative
 * is a board that cannot let go of a session once it has seen one. The carry is
 * read ONLY when the live read failed, which is what keeps a call on the wall
 * through a vendor blip rather than blinking it out mid-instruction.
 *
 * Freshness is still the reader's job: `activeArenaCalls` drops anything past
 * the hold window, so even a carry served through a long outage cannot leave a
 * twenty-minute-old instruction up.
 */
export async function readCalledArenaSessions(
  venue: SignageVenue,
  nowMs: number,
): Promise<ArenaCall[]> {
  const hit = cache.get(venue);
  if (hit && nowMs - hit.at < CACHE_TTL_MS) return hit.calls;

  // Pandora keys its session endpoints on the SQUARE location id, not on the
  // numeric Office id — see the note on VenueInfo.squareLocationId. The arena
  // SMS cron hands Pandora the same string from the same source.
  const locationId = VENUE_INFO[venue]?.squareLocationId;
  if (!locationId) return [];

  const live = await fetchCalled(locationId);
  const calls = live ?? (await readCarry(locationId));
  if (live) void writeCarry(locationId, live);

  cache.set(venue, { at: nowMs, calls });
  return calls;
}
