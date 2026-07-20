import { randomBytes } from "crypto";
import redis from "@/lib/redis";
import {
  CLOSED_GRACE_SEC,
  SESSION_TTL_SEC,
  type ClientStage,
  type JoinClientPresence,
  type JoinSession,
  type JoinedGuest,
} from "./types";

/**
 * Atomic Redis ops for the mobile-join session. Concurrency safety comes from
 * key SHAPE, not transactions: the meta blob has a single writer (kiosk-driven
 * code paths), concurrent phone joins RPUSH a list (appends commute), dedupe
 * is a first-writer-wins SADD, and presence is a per-field HSET. No Lua, no
 * WATCH/MULTI.
 */

const blobKey = (code: string) => `kiosk:join:${code}`;
const guestsKey = (code: string) => `kiosk:join:${code}:guests`;
const dedupeKey = (code: string) => `kiosk:join:${code}:dedupe`;
const clientsKey = (code: string) => `kiosk:join:${code}:clients`;
const pointerKey = (kioskId: string) => `kiosk:join:bykiosk:${kioskId}`;

/** 12 chars / 72 bits. Bigger than the 6-char redirect links on purpose —
 *  this token authorizes joining a live party. */
export function newJoinCode(): string {
  return randomBytes(9).toString("base64url");
}

export function newJoinId(): string {
  return randomBytes(6).toString("base64url");
}

export async function writeSession(s: JoinSession, ttlSec: number): Promise<void> {
  await redis.set(blobKey(s.code), JSON.stringify(s), "EX", ttlSec);
}

export async function readSession(code: string): Promise<JoinSession | null> {
  const raw = await redis.get(blobKey(code));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as JoinSession;
  } catch {
    return null;
  }
}

/** Slide every key of the session together (kiosk poll = keepalive). */
export async function refreshTtls(code: string, ttlSec: number): Promise<void> {
  await Promise.all([
    redis.expire(blobKey(code), ttlSec),
    redis.expire(guestsKey(code), ttlSec),
    redis.expire(dedupeKey(code), ttlSec),
    redis.expire(clientsKey(code), ttlSec),
  ]);
}

export async function pushGuest(code: string, g: JoinedGuest): Promise<void> {
  await redis.rpush(guestsKey(code), JSON.stringify(g));
  // Companion keys are created lazily by phone writes; stamp a TTL so none
  // outlives an unpolled session. The kiosk poll re-slides all of them.
  await redis.expire(guestsKey(code), SESSION_TTL_SEC);
}

export async function listGuests(code: string): Promise<JoinedGuest[]> {
  const raw = await redis.lrange(guestsKey(code), 0, -1);
  const out: JoinedGuest[] = [];
  for (const entry of raw) {
    try {
      out.push(JSON.parse(entry) as JoinedGuest);
    } catch {
      /* skip a corrupt entry rather than fail the poll */
    }
  }
  return out;
}

export async function guestCount(code: string): Promise<number> {
  return redis.llen(guestsKey(code));
}

/** First-writer-wins identity claim. True = this guest is new to the session. */
export async function tryClaimIdentity(code: string, identityKey: string): Promise<boolean> {
  const added = await redis.sadd(dedupeKey(code), identityKey);
  await redis.expire(dedupeKey(code), SESSION_TTL_SEC);
  return added === 1;
}

/** Undo a claim when the follow-up RPUSH failed, so a retry can succeed. */
export async function releaseIdentity(code: string, identityKey: string): Promise<void> {
  await redis.srem(dedupeKey(code), identityKey);
}

export async function heartbeat(code: string, clientId: string, stage: ClientStage): Promise<void> {
  await redis.hset(
    clientsKey(code),
    clientId,
    JSON.stringify({ lastSeen: Date.now(), stage } satisfies JoinClientPresence),
  );
  await redis.expire(clientsKey(code), SESSION_TTL_SEC);
}

export async function readClients(code: string): Promise<Record<string, JoinClientPresence>> {
  const h = await redis.hgetall(clientsKey(code));
  const out: Record<string, JoinClientPresence> = {};
  for (const [clientId, raw] of Object.entries(h)) {
    try {
      const parsed = JSON.parse(raw) as JoinClientPresence;
      if (typeof parsed?.lastSeen === "number") out[clientId] = parsed;
    } catch {
      /* stale/corrupt presence entries just age out */
    }
  }
  return out;
}

/** One open session per kiosk — creating a new one supersedes the old. */
export async function setKioskPointer(kioskId: string, code: string): Promise<void> {
  await redis.set(pointerKey(kioskId), code, "EX", 7200);
}

export async function getKioskPointer(kioskId: string): Promise<string | null> {
  return redis.get(pointerKey(kioskId));
}

/** Delete the pointer only if it still points at `code` (a newer session may
 *  have replaced it between our read and delete — never clobber that). */
export async function delKioskPointerIfCurrent(kioskId: string, code: string): Promise<void> {
  const current = await redis.get(pointerKey(kioskId));
  if (current === code) await redis.del(pointerKey(kioskId));
}

/** Shrink every key to the post-close grace window. */
export async function applyClosedGrace(code: string): Promise<void> {
  await refreshTtls(code, CLOSED_GRACE_SEC);
}

/**
 * Per-IP rate counter (INCR+EXPIRE, 5-min window). FAIL-OPEN: venue kiosks
 * and guest phones share one NAT egress IP, so these are lax backstops — the
 * real guards are token entropy, short TTLs, and per-session caps.
 */
export async function rateLimited(route: string, ip: string, limit: number): Promise<boolean> {
  try {
    const key = `rl:kiosk-join:${route}:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 300);
    return count > limit;
  } catch {
    return false;
  }
}
