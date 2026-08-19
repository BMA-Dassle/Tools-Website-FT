import "server-only";

/**
 * THE CALLED-HEAT SHADOW — phase 0 of moving session status off Pandora polling.
 *
 * `/api/cron/races-current-warm` learns the called heat by asking Pandora once a
 * second, all day: ~2,200 calls an hour, ~53,000 a day, and more than half of
 * everything we send that vendor. The venue's own WebSocket already pushes the
 * same fact — `SessionAboutToStartNotification` — and we have never listened.
 *
 * THIS FILE CHANGES NOTHING THAT ANYONE SEES. It writes to its own keys
 * (`venue:called:*`), which no board, wall or route reads. Its whole job is to
 * earn the right to write the real carry (`pandora:last-race:fasttrax:*`) by
 * proving, against a live race day, that it agrees with Pandora about every
 * called heat and is never wrong about a track. `scripts/venue-called-diff.mts`
 * is the scoreboard.
 *
 * WHY A SHADOW AND NOT JUST THE SWITCH: the carry is the single piece of state
 * the entire estate reads, and `refreshRacesCurrent` wraps it in behaviour that
 * is easy to miss — `preserveFirstCall` pins a re-called heat to its FIRST
 * calledAt so clocks don't reset, and the desk's "Clear" tombstones must swallow
 * a call and retire on a genuine re-call. A second writer that gets any of that
 * wrong puts a wrong heat, or a cleared heat, on every screen in the building.
 * The v2 cutover rule in CLAUDE.md says deploy alongside, prove, then switch.
 *
 * WHAT WE ALREADY KNOW, MEASURED (2026-08-19, 92 called heats):
 *   - median 5.2s earlier than what we recorded from Pandora, min 0.3s
 *   - four heats minutes earlier (789s, 378s, 143s, 71s) — the degradation windows
 *   - one heat 11s LATER, so the poll is not strictly redundant
 *   - `ResourceId` gives the track outright: 11208654 blue, 11208660 red, -1 mega
 *
 * WHAT THE SHADOW DAY HAS TO ANSWER, none of which the buffer can:
 *   1. does a call event arrive for EVERY heat Pandora reports called?
 *   2. does it fire again on a RE-CALL (the case preserveFirstCall exists for)?
 *   3. is the track ever unresolvable in practice?
 *   4. how does it behave around a desk Clear?
 *
 * Never throws. It runs inside the kart webhook's `after()`, on the same hot path
 * as the race clock and the incident log; an exotic message must cost nothing and
 * break nothing.
 */
import redis from "@/lib/redis";
import type { TrackKey } from "~/features/signage/track";
import {
  extractRaceFinishes,
  extractRaceStarts,
  extractSessionCalls,
  extractSessionLifecycle,
} from "~/features/racing/venue-broadcast";

/** One key per track, mirroring the real carry's shape so a later promotion is a
 *  change of key name and a merge call, not a reshape. */
const CALLED_KEY = (t: TrackKey) => `venue:called:${t}`;
/** Append-only evidence: every call/green/finish with BOTH stamps, so the diff
 *  script can compare a whole day instead of only the current state. */
const LOG_KEY = "venue:called:log";
const LOG_MAX = 2_000;
const LOG_TTL_SECONDS = 60 * 60 * 72;
/** Long enough to outlive a race day, short enough that a stale shadow cannot
 *  masquerade as today's state. */
const CALLED_TTL_SECONDS = 60 * 60 * 18;

export type VenueCalledPhase = "called" | "started" | "finished";

export interface VenueCalledState {
  sessionId: string;
  track: TrackKey;
  heatNumber: number | null;
  sessionName: string;
  phase: VenueCalledPhase;
  /** The venue's own stamp for the call, ms. */
  calledAtMs: number | null;
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
 * Fold one webhook message into the shadow state.
 *
 * Ordering is guaranteed by the bridge POSTing serially, which is what makes the
 * read-modify-write below safe without a lock — the same reasoning
 * `updateRaceClocks` relies on.
 */
export async function observeVenueCalls(message: unknown, seenAtMs: number): Promise<void> {
  try {
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
      // A RE-CALL of the heat we already hold keeps its first stamp, mirroring
      // preserveFirstCall so the shadow can be compared to the carry at all.
      const isSameHeat = prior?.sessionId === call.sessionId;
      const state: VenueCalledState = {
        sessionId: call.sessionId,
        track: call.track,
        heatNumber: call.heatNumber,
        sessionName: call.sessionName,
        phase: "called",
        calledAtMs: isSameHeat ? (prior?.calledAtMs ?? call.atMs) : call.atMs,
        seenAtMs: isSameHeat ? prior.seenAtMs : seenAtMs,
      };
      await writeState(state);
      await appendLog({ ...state, event: "call" });
      console.log(
        `[venue-called] CALL ${call.track} heat ${call.heatNumber ?? "?"} session ${call.sessionId}` +
          `${isSameHeat ? " (re-call, first stamp kept)" : ""}`,
      );
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
      // session means our shadow missed its call, and inventing state here would
      // hide exactly the gap the shadow day is meant to measure.
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
      // races (age-gated) so a board is not blank in the gap; the shadow keeps
      // the same shape so the comparison stays like-for-like.
      const state: VenueCalledState = { ...prior, phase: "finished", finishedAtMs: end.atMs };
      await writeState(state);
      await appendLog({ ...state, event: "finish" });
    }
  } catch (err) {
    // Swallowed by design — see the file header. A shadow that can break the
    // webhook is worse than no shadow.
    console.error("[venue-called] observe failed:", err);
  }
}

/** All three shadow keys — for the diff script and any future admin panel. */
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
