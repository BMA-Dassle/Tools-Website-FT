import "server-only";

/**
 * THE SWEEP — once a minute, ask each briefing room's camera whether the group
 * has left, and if they have, move them to holding.
 *
 * The decision itself is pure and lives in auto-holding.ts; this is the I/O
 * around it. Read that file first — it carries the why, the evidence, and the
 * reason this is not the auto-advance timer the owner had removed.
 *
 * ─── COST DISCIPLINE ─────────────────────────────────────────────────────
 *
 * The timing gate is evaluated BEFORE anything leaves the process. A room that
 * is idle, still playing its film, or still on the helmet board is decided from
 * Redis state alone and costs nothing — so on a quiet afternoon this sweep is
 * one Redis MGET a minute and no Nx traffic at all. The relay is only asked
 * about a room that is genuinely in the window where a group could have walked
 * out, which is at most two calls a minute during a race night.
 *
 * ─── THE CLAIM IS TAKEN LAST ─────────────────────────────────────────────
 *
 * `SET NX` immediately before the move, not at the top of the loop. Claiming
 * first would mean a room that was still busy burned its one chance and could
 * never be swept again — the sweep must be free to look at the same room every
 * minute and keep saying no. Once it says yes, the claim makes that yes happen
 * exactly once even if two cron invocations overlap.
 */
import redis from "@/lib/redis";
import { BRIEFING_ROOM_CAMERAS } from "../nx/camera.server";
import { motionInLast, type MotionAnswer } from "../nx/motion.server";
import { readPitLane, sendToHolding } from "../pit/lane.server";
import type { TrackKey } from "../track";
import { autoHoldingDecision, QUIET_WINDOW_MS, type RoomMotion } from "./auto-holding";
import { briefingEnabled } from "../flags";
import { readBriefingRooms } from "./state.server";
import { BRIEFING_ROOMS, type BriefingRoom } from "./types";

const VENUE = "FT";

/* ── the staff-facing kill switch ─────────────────────────────────────── */

/**
 * WHY REDIS AND NOT AN ENV VAR (owner 2026-08-14: "build it with the kill switch
 * in settings of the check in board").
 *
 * The house rule is that flags are kill switches only and default ON, and this
 * obeys it — absent key means enabled. What it does not do is live in the
 * environment, because the person who needs to reach for this switch is the one
 * watching a room get closed while a group is still standing in it, at 9pm, on
 * the desk PC. An env var means finding somebody with a Vercel login and waiting
 * out a redeploy. This is a toggle on the board they are already looking at, and
 * it takes effect on the next sweep.
 *
 * NO TTL. A kill switch that quietly expires back to ON is worse than no switch
 * at all: it would come back by itself, on a different shift, with nobody
 * having decided that it should.
 */
const SWITCH_KEY = `briefing:auto-holding:enabled`;

export async function autoHoldingEnabled(): Promise<boolean> {
  try {
    // Only the explicit string "0" disables. An unreachable Redis, a missing key
    // or anything unrecognised reads as ON — the same direction as every other
    // kill switch in flags.ts, so a Redis blip cannot silently stop the sweep.
    return (await redis.get(SWITCH_KEY)) !== "0";
  } catch {
    return true;
  }
}

export async function setAutoHoldingEnabled(enabled: boolean): Promise<void> {
  await redis.set(SWITCH_KEY, enabled ? "1" : "0");
}

/* ── the one-shot claim ───────────────────────────────────────────────── */

/** Outlives a night so a session cannot be auto-moved twice, expires before the
 *  next one so the key space does not grow forever. */
const CLAIM_TTL_SECONDS = 6 * 3600;

async function claimMove(sessionId: string): Promise<boolean> {
  try {
    const key = `briefing:auto-holding-done:${sessionId}`;
    return (await redis.set(key, String(Date.now()), "EX", CLAIM_TTL_SECONDS, "NX")) === "OK";
  } catch {
    // Redis unreachable: refuse rather than risk a double move. sendToHolding
    // displaces the previous holding group into `racing`, so doing it twice is
    // not idempotent from the pit board's point of view.
    return false;
  }
}

/* ── the sweep ────────────────────────────────────────────────────────── */

export interface AutoHoldingRoomResult {
  room: BriefingRoom;
  sessionId: string | null;
  heatNumber: number | null;
  moved: boolean;
  /** Why not, when not — the cron response is the only place anyone will look. */
  why: string;
  motion?: MotionAnswer;
}

export interface AutoHoldingRunResult {
  ok: true;
  enabled: boolean;
  moved: number;
  rooms: AutoHoldingRoomResult[];
}

export async function runAutoHolding(
  opts: { dryRun?: boolean } = {},
): Promise<AutoHoldingRunResult> {
  const now = Date.now();
  // The feature-wide switch first: if briefings are off entirely, this is off.
  const enabled = briefingEnabled() && (await autoHoldingEnabled());

  const rooms = await readBriefingRooms(VENUE).catch(() => ({ red: null, blue: null }));
  const results: AutoHoldingRoomResult[] = [];
  let moved = 0;

  for (const room of BRIEFING_ROOMS) {
    const state = rooms[room];
    const base = {
      room,
      sessionId: state?.sessionId ?? null,
      heatNumber: state?.heatNumber ?? null,
    };

    // PASS ONE — everything decidable without leaving the process. `unknown`
    // motion is passed in deliberately: if the timing gate has not opened, the
    // verdict must come back as a timing refusal and no camera is consulted.
    const dry = autoHoldingDecision({
      nowMs: now,
      state,
      motion: "unknown",
      holdingSessionId: null,
      enabled,
    });
    if (!dry.move && dry.why !== "no camera answer") {
      results.push({ ...base, moved: false, why: dry.why });
      continue;
    }

    // PASS TWO — the room is genuinely in the window. Now it is worth asking the
    // lane and the NVR.
    const track = (state?.track ?? null) as TrackKey | null;
    const lane = track ? await readPitLane(track).catch(() => null) : null;
    const motion: RoomMotion = await motionInLast(
      BRIEFING_ROOM_CAMERAS[room],
      QUIET_WINDOW_MS,
      now,
    );

    const verdict = autoHoldingDecision({
      nowMs: now,
      state,
      motion,
      holdingSessionId: lane?.holding?.sessionId ?? null,
      enabled,
    });
    if (!verdict.move) {
      results.push({ ...base, moved: false, why: verdict.why, motion });
      continue;
    }
    if (!track) {
      results.push({ ...base, moved: false, why: "room state has no track", motion });
      continue;
    }
    if (opts.dryRun) {
      results.push({ ...base, moved: false, why: "would move (dry run)", motion });
      continue;
    }
    if (!(await claimMove(verdict.sessionId))) {
      results.push({ ...base, moved: false, why: "already claimed", motion });
      continue;
    }

    try {
      await sendToHolding({
        room,
        track,
        sessionId: verdict.sessionId,
        heatNumber: verdict.heatNumber,
        raceType: verdict.raceType,
        // Recorded as its own end reason, never as a staff press — see
        // events-db.ts. An insurance log must not claim a person observed this.
        reason: "auto-holding",
      });
      moved++;
      results.push({ ...base, moved: true, why: "room empty — moved to holding", motion });
    } catch (err) {
      console.error(`[auto-holding] ${room} session ${verdict.sessionId} failed`, err);
      results.push({ ...base, moved: false, why: "sendToHolding threw", motion });
    }
  }

  return { ok: true, enabled, moved, rooms: results };
}
