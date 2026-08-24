import "server-only";

/**
 * WHEN DID THE GROUP ACTUALLY WALK BACK IN — stamped once, server-side.
 *
 * The greeting used to be timed off the post press alone, which the room
 * cameras show is ~30s early for the median group (480 presses measured
 * 2026-08-23). This module turns the room camera's own motion into two
 * one-shot, session-keyed stamps every TV agrees on:
 *
 *   `briefing:return-arrived:{sessionId}` — first motion onset after the post
 *   press: the group walking in, and the greeting's anchor.
 *
 *   `briefing:return-linger:{sessionId}` — the room still moving three minutes
 *   after they walked in: the cue for the once-only "another group is waiting"
 *   clip. Measured norm is out in 1:27, 80% inside 3:00 — three minutes of
 *   continued motion is the tail worth nagging.
 *
 * SERVER STAMPS, NOT CLIENT CLOCKS, for the same reason postPlayedAtMs is one:
 * both room TVs and a mid-window reboot must agree when the greeting started,
 * or a remount re-greets a group that walked in ten minutes ago (the exact bug
 * the post anchor fixed on 2026-08-15).
 *
 * ─── COST DISCIPLINE ─────────────────────────────────────────────────────
 * This rides the welcome-back resolver, which runs on the TV's 15s poll — but
 * an NVR read only happens (a) after the post press, (b) inside a 15-minute
 * watch window, (c) while a stamp is still missing, and (d) behind a short
 * NX claim so two TVs polling the same room cost one read, not two. A room
 * with both stamps (or an old return) costs one Redis MGET and no Nx traffic.
 */
import redis from "@/lib/redis";
import { BRIEFING_ROOM_CAMERAS } from "../nx/camera.server";
import { motionBetween, readMotionPeriods } from "../nx/motion.server";
import { firstOnsetAfter, LINGER_AFTER_MS, lingerDue } from "./return-greeting";
import type { BriefingRoom } from "./types";

/** Outlives the night, expires before the next one — same shape as the other
 *  per-session claims (auto-holding-done, return-announced). */
const STAMP_TTL_SECONDS = 6 * 3600;

/** Stop consulting the NVR this long after the post press. The greeting
 *  window is 2 minutes and the linger check needs arrival + 3, so a quarter
 *  hour covers every real return with slack; past it the stamps stand on
 *  their own and a stale board costs nothing. */
const WATCH_WINDOW_MS = 15 * 60_000;

/** Two TVs poll each room. The claim makes one of them pay for the Nx read
 *  each cycle; the other serves the stamps it can already see. */
const NX_CLAIM_SECONDS = 8;

/** "Still moving" for the linger verdict = motion inside this recent window.
 *  Matches the motion index's own ~13s lag with room to spare. */
const STILL_MOVING_WINDOW_MS = 45_000;

export interface ReturnArrival {
  /** First motion onset after the post press — null until somebody walks in. */
  arrivedAtMs: number | null;
  /** The once-only linger cue — null unless the room out-stayed LINGER_AFTER_MS. */
  lingerAtMs: number | null;
  /** False when the NVR could not answer this cycle — the client's cue to use
   *  the fixed-timer fallback rather than waiting for a camera that is down. */
  motionHealthy: boolean;
}

const arrivedKey = (sessionId: string) => `briefing:return-arrived:${sessionId}`;
const lingerKey = (sessionId: string) => `briefing:return-linger:${sessionId}`;

async function readStamp(key: string): Promise<number | null> {
  try {
    const raw = await redis.get(key);
    const ms = raw == null ? NaN : Number(raw);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** SET NX + read-back: whoever wins the race, everyone serves the same stamp. */
async function stampOnce(key: string, atMs: number): Promise<number> {
  try {
    await redis.set(key, String(atMs), "EX", STAMP_TTL_SECONDS, "NX");
    return (await readStamp(key)) ?? atMs;
  } catch {
    return atMs;
  }
}

export async function resolveReturnArrival(
  room: BriefingRoom,
  sessionId: string,
  postPlayedAtMs: number,
  nowMs: number,
  /** The staff-set span from the settings sheet. Defaulted rather than
   *  required so a caller that has not read the setting still behaves. */
  lingerAfterMs: number = LINGER_AFTER_MS,
): Promise<ReturnArrival> {
  let [arrivedAtMs, lingerAtMs] = await Promise.all([
    readStamp(arrivedKey(sessionId)),
    readStamp(lingerKey(sessionId)),
  ]);

  // Everything already decided, or the return is old news — no Nx traffic.
  const settled = arrivedAtMs != null && lingerAtMs != null;
  const watching = nowMs - postPlayedAtMs <= WATCH_WINDOW_MS;
  if (settled || !watching) return { arrivedAtMs, lingerAtMs, motionHealthy: true };

  // One TV pays for the read per cycle; a poll that loses the claim serves the
  // stamps above unchanged and honestly reports the camera as healthy — the
  // winner is answering for it right now.
  try {
    const claimed = await redis.set(
      `briefing:return-arrival-claim:${sessionId}`,
      "1",
      "EX",
      NX_CLAIM_SECONDS,
      "NX",
    );
    if (claimed !== "OK") return { arrivedAtMs, lingerAtMs, motionHealthy: true };
  } catch {
    // Redis down: no claim possible, but a stampless answer is still honest.
    return { arrivedAtMs, lingerAtMs, motionHealthy: true };
  }

  const camera = BRIEFING_ROOM_CAMERAS[room];

  if (arrivedAtMs == null) {
    const spans = await readMotionPeriods(camera, postPlayedAtMs, nowMs);
    if (spans === "unknown") {
      // Release the claim so the NEXT poll — from either TV — retries at once
      // and gets told the camera is down itself, rather than idling out the
      // claim window believing a healthy camera simply saw nobody.
      await redis.del(`briefing:return-arrival-claim:${sessionId}`).catch(() => {});
      return { arrivedAtMs, lingerAtMs, motionHealthy: false };
    }
    const onset = firstOnsetAfter(spans, postPlayedAtMs);
    if (onset != null) arrivedAtMs = await stampOnce(arrivedKey(sessionId), onset);
    return { arrivedAtMs, lingerAtMs, motionHealthy: true };
  }

  // Arrived, not yet lingered: only worth a read once the span has elapsed.
  if (nowMs - arrivedAtMs < lingerAfterMs) {
    return { arrivedAtMs, lingerAtMs, motionHealthy: true };
  }
  const moving = await motionBetween(camera, nowMs - STILL_MOVING_WINDOW_MS, nowMs);
  // `unknown` deliberately does NOT mark the camera unhealthy here — the
  // greeting already ran off a real arrival stamp, and the only thing at stake
  // is an optional nag, which silence serves fine.
  if (moving === "motion" && lingerDue({ arrivedAtMs, stillMoving: true, nowMs, lingerAfterMs })) {
    lingerAtMs = await stampOnce(lingerKey(sessionId), nowMs);
  }
  return { arrivedAtMs, lingerAtMs, motionHealthy: true };
}
