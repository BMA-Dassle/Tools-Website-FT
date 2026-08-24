import "server-only";

/**
 * THE CALLED HEAT, FROM THE VENUE INSTEAD OF FROM A POLL.
 *
 * `/api/cron/races-current-warm` used to learn the called heat by asking Pandora
 * once a second, all day: ~2,200 calls an hour, ~53,000 a day, and more than half
 * of everything we send that vendor. The venue's own WebSocket pushes the same
 * fact — `SessionAboutToStartNotification` — and nothing listened until now.
 *
 * This writes the real carry (`pandora:last-race:fasttrax:*`) that every board,
 * wall and tablet reads, and the poll drops to a 30s net behind it. It also keeps
 * writing its own `venue:called:*` keys, which nothing reads, because those are
 * what `scripts/venue-called-diff.mts` compares the two rails with — the
 * scoreboard stays live after the switch.
 *
 * EVERY WRITE GOES THROUGH `recordCalledRace` → `applyCalledRace`, never directly
 * to Redis. The carry is the single piece of state the entire estate reads, and it
 * is wrapped in behaviour that is easy to miss: `preserveFirstCall` pins a
 * re-called heat to its FIRST calledAt so no countdown restarts, the desk's
 * "Clear" tombstone must swallow a call and be spent by a genuine re-call, and
 * `callIsStalerThanStored` stops a late answer moving the board backwards. A
 * second writer that reimplemented any of that is how a cleared heat returns to
 * every screen in the building.
 *
 * AND IT DECLINES RATHER THAN GUESSES. No track from `ResourceId`, no race type
 * from the dayplanner row, no heat number, no venue stamp → no write, and the poll
 * picks it up within one cycle. A fast lie on a wall is worse than a slow truth.
 *
 * ── WHAT THE HISTORY ALREADY PROVED (2026-08-19, 95 called heats, 8/16-8/19) ──
 *   - `ResourceId` gives the track outright and never lied: 11208654 blue,
 *     11208660 red, -1 mega — 0 wrong, 0 unresolvable.
 *   - Coverage 91/95. All four misses fell in ONE window (8/17 15:07-15:19) in
 *     which the buffer holds **zero frames of any kind** — our bridge was dead,
 *     not the venue silent. That is the case the Pandora poll must survive, and
 *     the reason it stays.
 *   - Lead over what we recorded: median 4.8s, p25 2.7s, p75 7.7s. 4 of 91 landed
 *     LATER than the poll.
 *
 * ── IT FIRES MORE THAN ONCE PER HEAT, AND THE FIRST ONE IS THE CALL ──
 * 35 of 94 heats (8/16-8/18) got two or more DISTINCT firings, so this has to be
 * handled rather than hoped away. The pattern is consistent across all of them:
 *
 *   FIRST firing  → 2-10s BEFORE we recorded the call (5s, 9s, 1s, 6s, 2s, 4s, 8s…)
 *   LATER firings → AFTER the call, while the heat still has not started
 *                   (-129s, -240s, -149s, -325s…) — the venue re-announcing a heat
 *                   that is due and still sitting on the grid.
 *
 * FIRST-FIRING-WINS is therefore the correct rule, and the re-announcements are
 * harmless under it (they neither advance nor reset the held heat).
 *
 * WHICH ALSO MEANS THE TAIL CASES ARE OUR RECORD BEING LATE, NOT THE VENUE BEING
 * EARLY. Mega 60's first firing was 21:30:01; we recorded 21:43:11 — and then
 * recorded heat 61 TWENTY SECONDS later, on a track whose heats run ten minutes
 * apart. That is the carry catching up in one go during the evening Pandora was
 * degraded, not a desk calling two heats 20s apart. The venue's timeline fits the
 * 10-minute cadence; ours does not.
 *
 * That is the case worth building for: when Pandora is sick, an event-TRIGGERED
 * Pandora read is just as sick, while state derived from this wire stays right.
 *
 * Note that 1,714 of 1,716 venue records arrive TWICE (~0.1s apart), so a naive
 * count reads 67 "re-calls" where only 35 heats truly re-fired. Firings are deduped
 * on (session, venue stamp) below for that reason.
 *
 * Never throws. It runs inside the kart webhook's `after()`, on the same hot path
 * as the race clock and the incident log; an exotic message must cost nothing and
 * break nothing.
 */
import redis from "@/lib/redis";
import type { TrackKey } from "~/features/signage/track";
import {
  extractRaceAdvice,
  extractRaceFinishes,
  extractRaceStarts,
  extractSessionCalls,
  extractSessionLifecycle,
} from "~/features/racing/venue-broadcast";
import { recordCalledRace, type CurrentRace } from "~/features/racing/races-current.server";

/** One key per track, mirroring the real carry's shape. Still written after the
 *  promotion below: it is the scoreboard `scripts/venue-called-diff.mts` reads to
 *  keep checking the two rails against each other. */
const CALLED_KEY = (t: TrackKey) => `venue:called:${t}`;
/** What the heat IS — race type and scheduled start — learned from RaceAdvice,
 *  which the call notification does not carry. Keyed by session. */
const META_KEY = (sessionId: string) => `venue:session-meta:${sessionId}`;
const META_TTL_SECONDS = 60 * 60 * 24;

/**
 * THE KILL SWITCH — two of them, and the Redis one is the one that matters.
 *
 * Default ON (house rule: a flag exists to turn a live feature OFF, never to gate
 * one in). Off means the venue stops writing the carry AND the poll goes back to
 * 1s stepping — i.e. exactly the behaviour that shipped before this change.
 *
 * WHY REDIS AND NOT JUST THE ENV VAR: a Vercel environment variable does not take
 * effect until a redeploy, so `VENUE_CALLED_FAST_PATH=false` is a next-deploy
 * switch, not an on-the-night one. This key flips in one command with no deploy,
 * which is what "turn it off, the boards look wrong" actually needs at 7pm on a
 * Saturday. `scripts/venue-called-switch.mts` is the interface.
 *
 * The env var stays as a belt-and-braces backstop for the case where Redis itself
 * is the thing misbehaving.
 *
 * FAILS OPEN — an unreadable switch leaves the fast path ON. If Redis cannot be
 * read the carry cannot be read either, so the boards are already riding on
 * nothing; turning the wire off as well would only remove the one source still
 * arriving.
 */
const DISABLED_KEY = "venue:called:disabled";
/** Re-reading per webhook message would put a Redis round trip on the hot path;
 *  a few seconds of memo is plenty for an ops toggle. */
const SWITCH_MEMO_MS = 5_000;
let switchMemo: { enabled: boolean; readAt: number } | null = null;

export async function venueCalledFastPathEnabled(): Promise<boolean> {
  if (process.env.VENUE_CALLED_FAST_PATH === "false") return false;
  if (switchMemo && Date.now() - switchMemo.readAt < SWITCH_MEMO_MS) return switchMemo.enabled;
  try {
    const raw = await redis.get(DISABLED_KEY);
    const enabled = raw === null || raw === "0" || raw === "false";
    switchMemo = { enabled, readAt: Date.now() };
    return enabled;
  } catch (err) {
    console.warn("[venue-called] switch read failed, staying ON:", err);
    return true;
  }
}

/** Test seam — the memo would otherwise leak between cases. */
export function __resetSwitchMemo(): void {
  switchMemo = null;
}

export interface VenueSessionMeta {
  track: TrackKey;
  heatNumber: number | null;
  /** "Starter", "Junior Pro", "GF Starter" — the label Pandora puts in raceType. */
  raceType: string;
  scheduledStartIso: string | null;
  heatName: string;
}

/** Pandora's trackName values, which every board already renders. */
const TRACK_NAMES: Record<TrackKey, string> = { blue: "Blue", red: "Red", mega: "Mega" };

/**
 * "68 - Mega Starter" → "Starter"; "35 - Blue Junior Pro" → "Junior Pro";
 * "41 - Mega GF Starter" → "GF Starter"; "34 - Adult Only" → "Adult Only".
 *
 * Split the way Pandora splits it: strip the heat number, then the track word if
 * it leads. A name with neither (an un-configured "Heat 69") yields "", and the
 * caller refuses to write rather than put a blank type on a board.
 */
export function parseRaceType(heatName: string, track: TrackKey): string {
  const withoutHeat = heatName.replace(/^\s*\d+\s*-\s*/, "").trim();
  const trackWord = TRACK_NAMES[track];
  const withoutTrack = withoutHeat.replace(new RegExp(`^${trackWord}\\s+`, "i"), "").trim();
  // "Mega Track 67" and bare "Heat 69" carry no race type at all.
  if (!withoutTrack || /^track\b/i.test(withoutTrack) || /^heat\b/i.test(withoutTrack)) return "";
  return withoutTrack;
}
/** Append-only evidence: every call/green/finish with BOTH stamps, so the diff
 *  script can compare a whole day instead of only the current state. */
const LOG_KEY = "venue:called:log";
const LOG_MAX = 2_000;
const LOG_TTL_SECONDS = 60 * 60 * 72;
/** Long enough to outlive a race day, short enough that a stale comparison copy
 *  cannot masquerade as today's state. */
const CALLED_TTL_SECONDS = 60 * 60 * 18;

export type VenueCalledPhase = "called" | "started" | "finished";

export interface VenueCalledState {
  sessionId: string;
  track: TrackKey;
  heatNumber: number | null;
  sessionName: string;
  phase: VenueCalledPhase;
  /** The venue's stamp for the FIRST firing — the call. See the header for why
   *  the later ones are re-announcements and must not displace it. */
  calledAtMs: number | null;
  /** The most recent firing, kept only so the diff script can show how long a heat
   *  went on being re-announced before it started. */
  latestFiringMs: number | null;
  /** How many DISTINCT firings this heat got (duplicate deliveries excluded). */
  firings: number;
  /** When the frame reached US — the honest number for a latency comparison,
   *  since it includes the bridge hop and the webhook POST. */
  seenAtMs: number;
  /** Venue stamp for the green, once it lands. */
  startedAtMs?: number | null;
  /** Venue stamp for the flag, once it lands. */
  finishedAtMs?: number | null;
}

interface LogEntry extends VenueCalledState {
  event: "call" | "start" | "finish";
}

async function appendLog(entry: LogEntry): Promise<void> {
  try {
    await redis.lpush(LOG_KEY, JSON.stringify(entry));
    await redis.ltrim(LOG_KEY, 0, LOG_MAX - 1);
    await redis.expire(LOG_KEY, LOG_TTL_SECONDS);
  } catch (err) {
    console.warn("[venue-called] log append failed:", err);
  }
}

async function readState(track: TrackKey): Promise<VenueCalledState | null> {
  try {
    const raw = await redis.get(CALLED_KEY(track));
    return raw ? (JSON.parse(raw) as VenueCalledState) : null;
  } catch (err) {
    console.warn("[venue-called] read failed:", err);
    return null;
  }
}

async function writeState(state: VenueCalledState): Promise<void> {
  try {
    await redis.set(CALLED_KEY(state.track), JSON.stringify(state), "EX", CALLED_TTL_SECONDS);
  } catch (err) {
    console.warn("[venue-called] write failed:", err);
  }
}

/**
 * Put a venue-sourced call into the real carry, through `recordCalledRace` — the
 * one seam that owns re-call pinning, the desk's Clear tombstone and the
 * out-of-order guard. This function's only job is to build a `CurrentRace` that
 * is honest, or to decline.
 *
 * IT DECLINES ON MISSING METADATA, on purpose. The call notification carries a
 * session, a name and a resource; it does NOT carry the race type or the
 * scheduled start, both of which every board renders. Writing a heat with a blank
 * type would look like a bug on the glass, and inventing a scheduled start would
 * corrupt the on-time numbers. The 30-second poll fills those cases within one
 * cycle, which is strictly better than a fast lie.
 */
async function writeCarryFromCall(
  sessionId: string,
  track: TrackKey,
  heatNumber: number | null,
  calledAtMs: number,
): Promise<void> {
  let meta: VenueSessionMeta | null = null;
  try {
    const rawMeta = await redis.get(META_KEY(sessionId));
    if (rawMeta) meta = JSON.parse(rawMeta) as VenueSessionMeta;
  } catch (err) {
    console.warn("[venue-called] meta read failed:", err);
  }
  const heat = heatNumber ?? meta?.heatNumber ?? null;
  if (!meta?.raceType || heat == null) {
    console.log(
      `[venue-called] not writing carry for ${track} session ${sessionId} — ` +
        `${!meta ? "no RaceAdvice metadata yet" : !meta.raceType ? "no race type" : "no heat number"}; ` +
        `leaving it to the poll`,
    );
    return;
  }

  const race: CurrentRace = {
    trackName: TRACK_NAMES[track],
    raceType: meta.raceType,
    heatNumber: heat,
    scheduledStart: meta.scheduledStartIso ?? undefined,
    calledAt: new Date(calledAtMs).toISOString(),
    // Number, matching what races/current sends and what every consumer of the
    // carry already reads. Safe here and only here: RaceIds are 8 digits on this
    // wire (verified, 2,496 records) — a 17-digit id would need the string path.
    sessionId: Number(sessionId),
  };
  const held = await recordCalledRace(track, race);
  console.log(
    held?.sessionId === race.sessionId
      ? `[venue-called] CARRY ${track} ← heat ${heat} ${meta.raceType} (called ${race.calledAt})`
      : `[venue-called] carry unchanged for ${track} — seam refused (cleared or staler)`,
  );
}

/**
 * Fold one webhook message into the carry and the comparison keys.
 *
 * Ordering is guaranteed by the bridge POSTing serially, which is what makes the
 * read-modify-write below safe without a lock — the same reasoning
 * `updateRaceClocks` relies on.
 */
export async function observeVenueCalls(message: unknown, seenAtMs: number): Promise<void> {
  try {
    // ── what each heat IS, from the dayplanner rows that stream all day ───────
    // Learned BEFORE the call is handled, because a call for a heat we know
    // nothing about cannot be written to the carry (see below) — and a heat's
    // RaceAdvice almost always precedes its call by minutes or hours.
    for (const advice of extractRaceAdvice(message)) {
      if (!advice.track || !advice.heatName) continue;
      const raceType = parseRaceType(advice.heatName, advice.track);
      if (!raceType) continue;
      const meta: VenueSessionMeta = {
        track: advice.track,
        heatNumber: advice.heatNumber,
        raceType,
        scheduledStartIso: advice.scheduledStartMs
          ? new Date(advice.scheduledStartMs).toISOString()
          : null,
        heatName: advice.heatName,
      };
      await redis
        .set(META_KEY(advice.raceId), JSON.stringify(meta), "EX", META_TTL_SECONDS)
        .catch(() => void 0);
    }

    // ── the call ──────────────────────────────────────────────────────────────
    for (const call of extractSessionCalls(message)) {
      if (!call.track) {
        // Deliberately loud: an unresolvable track is exactly the case that would
        // make a promoted writer dangerous, and it must not pass silently.
        console.warn(
          `[venue-called] call with NO TRACK — session ${call.sessionId} "${call.sessionName}"`,
        );
        continue;
      }
      const prior = await readState(call.track);
      const isSameHeat = prior?.sessionId === call.sessionId;
      // DUPLICATE DELIVERY, NOT A RE-FIRE: the same venue record reaches us twice
      // (1,714 of 1,716 in the buffer). Dropping an identical (session, stamp)
      // keeps the firing count honest, which is the number the whole question
      // turns on.
      if (isSameHeat && prior.calledAtMs === call.atMs && prior.firings >= 1) continue;
      const state: VenueCalledState = {
        sessionId: call.sessionId,
        track: call.track,
        heatNumber: call.heatNumber,
        sessionName: call.sessionName,
        phase: "called",
        // FIRST FIRING WINS — established in the header: the first is the call, the
        // later ones are the venue re-announcing a heat that is due and still on the
        // grid. Also mirrors preserveFirstCall, so a re-announcement cannot reset a
        // waiting clock.
        calledAtMs: isSameHeat ? (prior?.calledAtMs ?? call.atMs) : call.atMs,
        latestFiringMs: call.atMs,
        firings: isSameHeat ? prior.firings + 1 : 1,
        seenAtMs: isSameHeat ? prior.seenAtMs : seenAtMs,
      };
      await writeState(state);
      await appendLog({ ...state, event: "call" });
      console.log(
        `[venue-called] DUE ${call.track} heat ${call.heatNumber ?? "?"} session ${call.sessionId}` +
          `${isSameHeat ? ` (firing #${state.firings})` : ""}`,
      );

      // ── AND NOW THE CARRY ITSELF ────────────────────────────────────────────
      // Only the FIRST firing writes: later ones are the venue re-announcing a
      // heat still on the grid, and `preserveFirstCall` would pin them anyway —
      // skipping saves a pointless read-modify-write on every re-announcement.
      if (isSameHeat || !(await venueCalledFastPathEnabled())) continue;
      // A heat that has already run is not "called". Without this, a late
      // re-announcement could resurrect a finished heat onto the board.
      if (prior?.sessionId === call.sessionId && prior.phase === "finished") continue;
      if (!call.atMs) continue; // no stamp, no clock — leave it to the poll
      await writeCarryFromCall(call.sessionId, call.track, call.heatNumber, call.atMs);
    }

    // ── the green: either notification or the RaceStart record ────────────────
    const greens = [
      ...extractSessionLifecycle(message)
        .filter((l) => l.kind === "started")
        .map((l) => ({ sessionId: l.sessionId, track: l.track, atMs: l.atMs })),
      ...extractRaceStarts(message).map((r) => ({
        sessionId: r.raceId,
        track: r.track,
        atMs: r.actualStartMs,
      })),
    ];
    for (const green of greens) {
      if (!green.track) continue;
      const prior = await readState(green.track);
      // Only advance the heat we are actually holding: a green for some other
      // session means we missed its call, and inventing state here would hide
      // exactly the coverage gap the diff script exists to surface.
      if (!prior || prior.sessionId !== green.sessionId) continue;
      if (prior.phase === "started" || prior.phase === "finished") continue;
      const state: VenueCalledState = { ...prior, phase: "started", startedAtMs: green.atMs };
      await writeState(state);
      await appendLog({ ...state, event: "start" });
    }

    // ── the flag ──────────────────────────────────────────────────────────────
    const ends = [
      ...extractSessionLifecycle(message)
        .filter((l) => l.kind === "finished")
        .map((l) => ({ sessionId: l.sessionId, track: l.track, atMs: l.atMs })),
      ...extractRaceFinishes(message).map((r) => ({
        sessionId: r.raceId,
        track: r.track,
        atMs: r.actualEndMs,
      })),
    ];
    for (const end of ends) {
      if (!end.track) continue;
      const prior = await readState(end.track);
      if (!prior || prior.sessionId !== end.sessionId) continue;
      if (prior.phase === "finished") continue;
      // NOT deleted. The real carry deliberately holds a finished heat between
      // races (age-gated) so a board is not blank in the gap; these keys keep the
      // same shape so the comparison stays like-for-like.
      const state: VenueCalledState = { ...prior, phase: "finished", finishedAtMs: end.atMs };
      await writeState(state);
      await appendLog({ ...state, event: "finish" });
    }
  } catch (err) {
    // Swallowed by design — see the file header. This runs beside the race clock
    // and the incident log; a handler that can break the webhook is worse than a
    // handler that misses one heat, which the 30s poll then covers.
    console.error("[venue-called] observe failed:", err);
  }
}

/** All three comparison keys — for the diff script and any future admin panel. */
export async function readVenueCalledAll(): Promise<Record<TrackKey, VenueCalledState | null>> {
  const [blue, red, mega] = await Promise.all([
    readState("blue"),
    readState("red"),
    readState("mega"),
  ]);
  return { blue, red, mega };
}

/** The evidence log, newest first. */
export async function readVenueCalledLog(limit = LOG_MAX): Promise<LogEntry[]> {
  try {
    const raw = await redis.lrange(LOG_KEY, 0, limit - 1);
    return raw
      .map((r) => {
        try {
          return JSON.parse(r) as LogEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is LogEntry => e !== null);
  } catch (err) {
    console.warn("[venue-called] log read failed:", err);
    return [];
  }
}
