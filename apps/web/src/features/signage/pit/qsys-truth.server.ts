import "server-only";

/**
 * THE PA's STATE, CROSS-CHECKED — what every busy verdict now reads.
 *
 * Pandora's cache (GET /qsys/audio/live) is the fast path and stays the
 * default: it answers from memory and never touches the Core. But on
 * 2026-09-10 it froze with a zone stuck "playing" for an hour while claiming
 * `connected: true`, and the pit station locked every control behind
 * "PA busy" (the full account is in qsys-truth.ts). The Core's own answer
 * (GET /qsys/audio/status, proxied straight through to the device) was right
 * the whole time. So the cache is now sanity-checked against the Core (owner:
 * "you should be sanity checking every so often the QSYS live status"), and
 * three things send a read to the Core instead:
 *
 *   1. THE CACHE LOOKS FROZEN — a zone says playing but its frames have
 *      stopped (qsys-truth.ts liveSuspicion), or Pandora admits its link is
 *      down. This is the incident's signature and costs nothing when the
 *      cache is healthy.
 *   2. THE SANITY BEAT — once every SANITY_EVERY_S across the whole venue
 *      (an NX claim, so every poller and every wall shares one), the Core is
 *      asked regardless and its answer compared to the cache. This catches
 *      the freeze the other way round: a cache stuck IDLE while a clip really
 *      plays, which suspicion alone cannot see (silence is what idle looks
 *      like).
 *   3. DISTRUST — when a check finds the two disagreeing, the cache is
 *      bypassed for DISTRUST_S and the Core is read directly on every call.
 *      The flag is not renewed by itself: the next sanity beat that finds them
 *      agreeing again lets it lapse, so a Pandora restart heals the path with
 *      no action from us. Every disagreement is console-warned as evidence for
 *      the Pandora-side fix (a socket keepalive it currently lacks).
 *
 * Reads are MEMOISED for MEMO_S so the tablet's 1-second poll and the wall
 * pulse share one Pandora call per beat instead of each making their own;
 * `fresh: true` bypasses the memo for the press path, where a stale beat
 * could let a post supersede a pre that started a second ago.
 *
 * Same fail-open posture as before: if neither source can be read the result
 * is null and the guard lets the press through — a blind refusal on a Pandora
 * blip is worse than the rare supersede the guard exists to stop.
 */
import redis from "@/lib/redis";
import { liveSuspicion, zonesDisagree } from "./qsys-truth";
import { readQsysLive, readQsysStatus, type QsysLiveState } from "./qsys.server";

export type QsysTruthSource = "live" | "status";

export interface QsysTruth extends QsysLiveState {
  /** Which read this picture came from: Pandora's cache, or the Core itself. */
  source: QsysTruthSource;
  /** Why the cache was not taken at its word — null when it was. Carried to
   *  the board so the station can say the feed is being second-guessed. */
  suspicion: string | null;
}

const DISTRUST_KEY = "pit:audio:qsys:distrust";
const SANITY_KEY = "pit:audio:qsys:sanity";
const MEMO_KEY = "pit:audio:qsys:truth";

const DISTRUST_S = 120;
const SANITY_EVERY_S = 30;
const MEMO_S = 2;

async function readMemo(): Promise<QsysTruth | null> {
  try {
    const raw = await redis.get(MEMO_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as QsysTruth;
  } catch {
    return null;
  }
}

async function writeMemo(truth: QsysTruth): Promise<void> {
  await redis.set(MEMO_KEY, JSON.stringify(truth), "EX", MEMO_S).catch(() => void 0);
}

async function distrusted(): Promise<boolean> {
  try {
    return (await redis.get(DISTRUST_KEY)) != null;
  } catch {
    return false;
  }
}

async function sanityBeatDue(): Promise<boolean> {
  try {
    return (await redis.set(SANITY_KEY, "1", "EX", SANITY_EVERY_S, "NX")) === "OK";
  } catch {
    return false;
  }
}

async function distrust(reason: string): Promise<void> {
  console.warn(
    `[qsys] Pandora's live cache disagrees with the Core — ${reason}; reading the Core directly for ${DISTRUST_S}s`,
  );
  await redis.set(DISTRUST_KEY, reason, "EX", DISTRUST_S).catch(() => void 0);
}

/**
 * The reconciled picture. `fresh` skips the memo (press path); everything
 * else rides the memo.
 */
export async function readQsysTruth(opts: { fresh?: boolean } = {}): Promise<QsysTruth | null> {
  if (!opts.fresh) {
    const memo = await readMemo();
    if (memo) return memo;
  }

  const nowMs = Date.now();
  const bypassCache = await distrusted();
  const live = bypassCache ? null : await readQsysLive();

  let suspicion: string | null = null;
  let askCore = bypassCache;
  if (live) {
    suspicion = liveSuspicion(live, nowMs);
    if (suspicion) askCore = true;
  } else if (!bypassCache) {
    // The cache could not be read at all — the Core is the only other source.
    askCore = true;
  }
  const beat = !askCore && (await sanityBeatDue());
  if (beat) askCore = true;

  let truth: QsysTruth | null = null;
  if (askCore) {
    const status = await readQsysStatus();
    if (status) {
      if (live) {
        const diff = zonesDisagree(live.zones, status.zones);
        if (diff) {
          await distrust(diff);
          suspicion = suspicion ?? diff;
        }
        // A beat that finds them agreeing sets nothing: an earlier distrust
        // flag is left to lapse on its own.
      }
      truth = { ...status, source: "status", suspicion };
    }
  }
  if (!truth && live) truth = { ...live, source: "live", suspicion };
  if (!truth) return null;

  await writeMemo(truth);
  return truth;
}
