import redis from "@/lib/redis";

/**
 * Video-block state lives in Redis in three layers:
 *
 *   video-block:session:{sessionId}                    — heat-wide block
 *   video-block:person:{sessionId}:{personId}          — per-racer override
 *   video-block:video:{videoCode}                      — per-video (admin UI)
 *
 * Resolution (see `getBlockState`):
 *   1. video-level present → BLOCKED
 *   2. person-level present:
 *      - `state: "unblock"` → NOT BLOCKED (explicit heat-override)
 *      - anything else      → BLOCKED
 *   3. session-level present → BLOCKED
 *   4. otherwise NOT BLOCKED
 *
 * TTL 14 days on every key — long enough to cover "block during a heat,
 * resolve days later after staff discussion" without cluttering Redis
 * forever. Longer than our 90-day match TTL isn't useful.
 *
 * Why three layers instead of one flag on the match record?
 * - Heat blocks have to take effect BEFORE the video arrives (may not
 *   even have a match record yet). The session-level key is the only
 *   source of truth until the cron sees the first video.
 * - Person-level override lets staff block a heat but individually
 *   release one racer (e.g., "block heat 15 except the birthday kid").
 * - Video-level is the post-match admin lever: a video already matched
 *   and maybe already notified can still be disabled on vt3.io via
 *   this flag (plus the VT3 API call the endpoint makes).
 */

const TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

export type BlockLevel = "video" | "person" | "session";

export interface BlockCtx {
  /** Optional free-text reason — shown in admin tooltip + audit log. */
  reason?: string;
  /** Optional staff identifier (email, initials) — audit only. */
  blockedBy?: string;
}

interface StoredBlock {
  blockedAt: string;
  reason?: string;
  blockedBy?: string;
  /** Only ever set on person-level rows. "unblock" = explicit override. */
  state?: "block" | "unblock";
}

export interface BlockState {
  blocked: boolean;
  level?: BlockLevel;
  reason?: string;
  blockedAt?: string;
  blockedBy?: string;
}

function sessionKey(sessionId: string | number): string {
  return `video-block:session:${sessionId}`;
}

function personKey(sessionId: string | number, personId: string | number): string {
  return `video-block:person:${sessionId}:${personId}`;
}

function videoKey(videoCode: string): string {
  return `video-block:video:${videoCode}`;
}

/**
 * Resolve the effective block state for a match. `videoCode` is
 * optional — omit when checking before a video has arrived (camera-
 * assign UI just wants the session / person layers).
 */
export async function getBlockState(opts: {
  sessionId: string | number;
  personId: string | number;
  videoCode?: string;
}): Promise<BlockState> {
  const { sessionId, personId, videoCode } = opts;

  // Fetch all three in parallel — same network round-trip.
  const keys: string[] = [
    personKey(sessionId, personId),
    sessionKey(sessionId),
  ];
  if (videoCode) keys.unshift(videoKey(videoCode));

  const raws = await redis.mget(...keys);
  const parsed: (StoredBlock | null)[] = raws.map((raw) => {
    if (!raw) return null;
    try { return JSON.parse(raw) as StoredBlock; } catch { return null; }
  });

  // Unpack in the order we queued: [videoKey?, personKey, sessionKey]
  let idx = 0;
  const vBlock = videoCode ? parsed[idx++] : null;
  const pBlock = parsed[idx++];
  const sBlock = parsed[idx++];

  if (vBlock) {
    return {
      blocked: true,
      level: "video",
      reason: vBlock.reason,
      blockedAt: vBlock.blockedAt,
      blockedBy: vBlock.blockedBy,
    };
  }
  if (pBlock) {
    if (pBlock.state === "unblock") {
      // Explicit override — person is NOT blocked regardless of session.
      return { blocked: false };
    }
    return {
      blocked: true,
      level: "person",
      reason: pBlock.reason,
      blockedAt: pBlock.blockedAt,
      blockedBy: pBlock.blockedBy,
    };
  }
  if (sBlock) {
    return {
      blocked: true,
      level: "session",
      reason: sBlock.reason,
      blockedAt: sBlock.blockedAt,
      blockedBy: sBlock.blockedBy,
    };
  }
  return { blocked: false };
}

/** Block every racer in one session / heat. */
export async function blockSession(sessionId: string | number, ctx?: BlockCtx): Promise<void> {
  const payload: StoredBlock = {
    blockedAt: new Date().toISOString(),
    reason: ctx?.reason,
    blockedBy: ctx?.blockedBy,
  };
  await redis.set(sessionKey(sessionId), JSON.stringify(payload), "EX", TTL_SECONDS);
}

export async function unblockSession(sessionId: string | number): Promise<void> {
  await redis.del(sessionKey(sessionId));
}

/**
 * Block one racer. If `override` is true (rare), writes a person-level
 * row with `state: "unblock"` — used when the heat is blocked but staff
 * wants to explicitly RELEASE just this one racer.
 */
export async function blockPerson(
  sessionId: string | number,
  personId: string | number,
  ctx?: BlockCtx,
): Promise<void> {
  const payload: StoredBlock = {
    blockedAt: new Date().toISOString(),
    reason: ctx?.reason,
    blockedBy: ctx?.blockedBy,
    state: "block",
  };
  await redis.set(
    personKey(sessionId, personId),
    JSON.stringify(payload),
    "EX",
    TTL_SECONDS,
  );
}

/**
 * Explicit override: "heat is blocked, but release this one racer".
 * Writes a person-level row with `state: "unblock"` that `getBlockState`
 * treats as NOT-BLOCKED even when the session row says otherwise.
 */
export async function overrideUnblockPerson(
  sessionId: string | number,
  personId: string | number,
  ctx?: BlockCtx,
): Promise<void> {
  const payload: StoredBlock = {
    blockedAt: new Date().toISOString(),
    reason: ctx?.reason,
    blockedBy: ctx?.blockedBy,
    state: "unblock",
  };
  await redis.set(
    personKey(sessionId, personId),
    JSON.stringify(payload),
    "EX",
    TTL_SECONDS,
  );
}

/** Clear any per-person row (both block + unblock overrides). */
export async function unblockPerson(
  sessionId: string | number,
  personId: string | number,
): Promise<void> {
  await redis.del(personKey(sessionId, personId));
}

export async function blockVideo(videoCode: string, ctx?: BlockCtx): Promise<void> {
  const payload: StoredBlock = {
    blockedAt: new Date().toISOString(),
    reason: ctx?.reason,
    blockedBy: ctx?.blockedBy,
  };
  await redis.set(videoKey(videoCode), JSON.stringify(payload), "EX", TTL_SECONDS);
}

export async function unblockVideo(videoCode: string): Promise<void> {
  await redis.del(videoKey(videoCode));
}

/**
 * Snapshot of block state for every racer in a session — used by the
 * camera-assign UI to paint names red without firing one Redis call
 * per racer.
 *
 * Returns an object keyed on personId. The caller already knows the
 * personId set (from `listAssignmentsForSession`), so this helper
 * takes that list as input to keep the Redis MGET narrow.
 */
export async function getSessionBlockSnapshot(opts: {
  sessionId: string | number;
  personIds: Array<string | number>;
}): Promise<{
  sessionBlock: BlockState;
  personBlocks: Record<string, BlockState>;
}> {
  const { sessionId, personIds } = opts;

  const personKeys = personIds.map((pid) => personKey(sessionId, pid));
  const allKeys = [sessionKey(sessionId), ...personKeys];

  const raws = allKeys.length > 0 ? await redis.mget(...allKeys) : [];
  const parsed: (StoredBlock | null)[] = raws.map((raw) => {
    if (!raw) return null;
    try { return JSON.parse(raw) as StoredBlock; } catch { return null; }
  });

  const sRaw = parsed[0];
  const sessionBlock: BlockState = sRaw
    ? {
        blocked: true,
        level: "session",
        reason: sRaw.reason,
        blockedAt: sRaw.blockedAt,
        blockedBy: sRaw.blockedBy,
      }
    : { blocked: false };

  const personBlocks: Record<string, BlockState> = {};
  personIds.forEach((pid, i) => {
    const pRaw = parsed[i + 1];
    const key = String(pid);
    if (pRaw) {
      if (pRaw.state === "unblock") {
        personBlocks[key] = { blocked: false, level: "person" };
      } else {
        personBlocks[key] = {
          blocked: true,
          level: "person",
          reason: pRaw.reason,
          blockedAt: pRaw.blockedAt,
          blockedBy: pRaw.blockedBy,
        };
      }
    } else if (sessionBlock.blocked) {
      // No person override → inherits session block.
      personBlocks[key] = {
        blocked: true,
        level: "session",
        reason: sessionBlock.reason,
        blockedAt: sessionBlock.blockedAt,
        blockedBy: sessionBlock.blockedBy,
      };
    } else {
      personBlocks[key] = { blocked: false };
    }
  });

  return { sessionBlock, personBlocks };
}
