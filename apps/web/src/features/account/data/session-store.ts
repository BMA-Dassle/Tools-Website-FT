import { randomBytes } from "crypto";
import redis from "@/lib/redis";
import { SESSION_IDLE_TTL_SEC } from "../constants";
import type { SessionRecord } from "../types";

const key = (sid: string) => `acct:session:${sid}`;

export function newSid(): string {
  return randomBytes(32).toString("base64url");
}

export async function writeSession(sid: string, record: SessionRecord): Promise<void> {
  await redis.set(key(sid), JSON.stringify(record), "EX", SESSION_IDLE_TTL_SEC);
}

export async function readSessionRecord(sid: string): Promise<SessionRecord | null> {
  const raw = await redis.get(key(sid));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionRecord;
  } catch {
    return null;
  }
}

/** Slide the idle expiry on each authenticated request. */
export async function slideSession(sid: string): Promise<void> {
  await redis.expire(key(sid), SESSION_IDLE_TTL_SEC);
}

export async function deleteSessionRecord(sid: string): Promise<void> {
  await redis.del(key(sid));
}
